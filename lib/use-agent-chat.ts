"use client";

import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { parseApprovalCard } from "./agent-tools";
import type { AgentInterrupt, Approval, ContextUsage, ThinkingLevel } from "./chat-types";

// The chat with the Python agent server (agent-server/main.py), on TanStack AI's
// useChat: it reads the server's AG-UI events (ag-ui-langgraph) as they are.
// `persistence: true`: the server owns the chat. useChat loads it, and any approval
// still waiting, from GET /agent, and with `history` each send posts only the new
// turn (the checkpointer has the rest). This adds the context meter and approvals.

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

export function useAgentChat({ url, threadId }: { url: string; threadId: string }) {
	// From the context_usage events of a reply: a reloaded chat shows none until the next.
	const [context, setContext] = useState<ContextUsage | null>(null);
	const outcome = useRef<string | null>(null); // how the last run ended, for answer()

	const connection = useMemo(() => fetchServerSentEvents(url), [url]);
	const chat = useChat({
		connection,
		threadId,
		persistence: true,
		history: { pageSize: 50 },
		onCustomEvent: (name, data) => name === "context_usage" && setContext(data as ContextUsage),
		onChunk: (chunk) => {
			if (chunk.type === "RUN_FINISHED") outcome.current = chunk.outcome?.type ?? "success";
			if (chunk.type === "RUN_ERROR") outcome.current = "failed";
		},
		onError: (e) => console.error("Agent run failed:", e),
	});
	const { messages, sendMessage, resumeInterruptsUnsafe, stop, isLoading } = chat;
	const approvals = useMemo(() => toApprovals(chat.interrupts as readonly AgentInterrupt[]), [chat.interrupts]);

	// main.py puts the thinking level into the agent's state.
	const send = useCallback(
		(text: string, thinkingLevel: ThinkingLevel) => sendMessage(text, { body: { thinkingLevel } }),
		[sendMessage],
	);

	// The user's decision for each waiting approval, sent once all have one (AG-UI
	// resumes every open interrupt at once). TanStack resumes only interrupts its own
	// server made, so this is its raw resume. Resolves true if the resumed reply
	// completed (not failed, stopped or paused again).
	const answer = useCallback(
		async (decisions: ReadonlyMap<string, boolean>) => {
			const resume = approvals.map((a) => ({
				interruptId: a.id,
				status: "resolved" as const,
				payload: { type: decisions.get(a.id) ? "approve" : "reject" },
			}));
			outcome.current = null;
			await resumeInterruptsUnsafe(resume);
			return outcome.current === "success";
		},
		[approvals, resumeInterruptsUnsafe],
	);

	return {
		messages,
		approvals,
		context,
		loading: chat.isHydrating,
		running: isLoading,
		// Waiting for the first word of the reply.
		thinking: isLoading && messages.at(-1)?.role === "user",
		error: chat.error ? new Error(REPLY_FAILED) : undefined,
		send,
		answer,
		stop,
	};
}
