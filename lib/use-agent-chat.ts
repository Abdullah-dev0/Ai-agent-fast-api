"use client";

import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { parseApprovalCard } from "./agent-tools";
import type { AgentInterrupt, Approval, ContextUsage, SavedChat, ThinkingLevel } from "./chat-types";

// The chat with the Python agent server (agent-server/main.py), on TanStack AI's
// useChat: it reads the server's AG-UI events (ag-ui-langgraph) as they are. This
// adds the saved chat on load, the context meter, and approvals.

const REPLY_FAILED = "Something went wrong with that reply. Try again.";
const NO_APPROVALS: Approval[] = []; // one value, so an empty list never counts as a change

function toApprovals(interrupts: readonly AgentInterrupt[]): Approval[] {
	const approvals = interrupts.flatMap((i) => {
		const raw = i.metadata?.langgraph?.raw;
		if (raw?.type !== "tool_approval") return [];
		const toolCallId = i.toolCallId ?? raw.tool_call_id ?? "";
		return [{ id: i.id, toolCallId, name: raw.name, args: raw.args, card: parseApprovalCard(raw.description) }];
	});
	return approvals.length ? approvals : NO_APPROVALS;
}

// useChat sends the whole conversation, with per-message data in forwardedProps. The
// server keeps the conversation itself and reads the thinking level from `state`, so
// send only the new message. (Old messages could also make ag-ui-langgraph rewind
// the thread if one differed from its saved copy.)
const agentFetch: typeof fetch = (input, init) => {
	if (init?.method !== "POST" || typeof init.body !== "string") return fetch(input, init);
	const body = JSON.parse(init.body);
	const last = body.messages?.at(-1);
	const resuming = body.resume?.length > 0;
	const { thinkingLevel, ...forwardedProps } = body.forwardedProps ?? {};
	body.messages = !resuming && last?.role === "user" ? [last] : [];
	body.state = !resuming && thinkingLevel ? { thinking_level: thinkingLevel } : {};
	body.forwardedProps = forwardedProps;
	return fetch(input, { ...init, body: JSON.stringify(body) });
};

export function useAgentChat({ url, threadId }: { url: string; threadId: string }) {
	const [context, setContext] = useState<ContextUsage | null>(null);
	const [saved, setSaved] = useState<AgentInterrupt[]>([]); // approvals waiting when the chat loaded
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<Error>();
	const outcome = useRef<string | null>(null); // how the last run ended, for answer()

	const connection = useMemo(() => fetchServerSentEvents(url, { fetchClient: agentFetch }), [url]);
	const chat = useChat({
		connection,
		threadId,
		onCustomEvent: (name, data) => name === "context_usage" && setContext(data as ContextUsage),
		onChunk: (chunk) => {
			if (chunk.type === "RUN_FINISHED") outcome.current = chunk.outcome?.type ?? "success";
			if (chunk.type === "RUN_ERROR") outcome.current = "failed";
		},
		onError: (e) => console.error("Agent run failed:", e),
	});
	const { messages, setMessages, sendMessage, resumeInterruptsUnsafe, stop, isLoading } = chat;
	// Live interrupts once a reply has paused, else the ones the saved chat had.
	const live = chat.interrupts as readonly AgentInterrupt[];
	const approvals = useMemo(() => toApprovals(live.length ? live : saved), [live, saved]);

	// The saved chat (GET /agent). Next keeps a chat you switch away from alive, so
	// this runs again when you come back: leave a running reply alone.
	const isRunning = useEffectEvent(() => isLoading);
	useEffect(() => {
		if (isRunning()) return;
		const controller = new AbortController();
		fetch(`${url}?threadId=${encodeURIComponent(threadId)}`, { signal: controller.signal })
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Could not load the chat (${res.status})`))))
			.then((data: SavedChat) => {
				setMessages(data.messages);
				setContext(data.context);
				setSaved(data.interrupts);
			})
			.catch((e: unknown) => !controller.signal.aborted && setLoadError(e instanceof Error ? e : new Error(String(e))))
			.finally(() => !controller.signal.aborted && setLoading(false));
		return () => controller.abort();
	}, [url, threadId, setMessages]);

	const send = useCallback(
		(text: string, thinkingLevel: ThinkingLevel) => {
			setSaved([]);
			return sendMessage(text, { body: { thinkingLevel } });
		},
		[sendMessage],
	);

	// The user's decision for each waiting approval, sent once all have one (AG-UI
	// resumes every open interrupt at once). TanStack resumes only interrupts its own
	// server made, so this is its raw resume; the run id is unused by our server.
	// Resolves true if the resumed reply completed (not failed, stopped or paused again).
	const answer = useCallback(
		async (decisions: ReadonlyMap<string, boolean>) => {
			const resume = approvals.map((a) => ({
				interruptId: a.id,
				status: "resolved" as const,
				payload: { type: decisions.get(a.id) ? "approve" : "reject" },
			}));
			setSaved([]);
			outcome.current = null;
			await resumeInterruptsUnsafe(resume, { threadId, runId: crypto.randomUUID() });
			return outcome.current === "success";
		},
		[approvals, resumeInterruptsUnsafe, threadId],
	);

	// Deletes the thread on the server (DELETE /agent), then empties the screen.
	const clear = useCallback(async () => {
		const res = await fetch(`${url}?threadId=${encodeURIComponent(threadId)}`, { method: "DELETE" });
		if (!res.ok) {
			setLoadError(new Error(`Could not delete the chat (${res.status})`));
			return false;
		}
		setMessages([]);
		setSaved([]);
		setContext(null);
		return true;
	}, [url, threadId, setMessages]);

	return {
		messages,
		approvals,
		context,
		loading,
		running: isLoading,
		// Waiting for the first word of the reply.
		thinking: isLoading && messages.at(-1)?.role === "user",
		error: loadError ?? (chat.error ? new Error(REPLY_FAILED) : undefined),
		send,
		answer,
		stop,
		clear,
	};
}
