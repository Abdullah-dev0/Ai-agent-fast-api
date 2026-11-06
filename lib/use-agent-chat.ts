"use client";

import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentInterrupt, ContextUsage, ThinkingLevel } from "./chat-types";
import { resumeItems, waitingApprovals } from "./langgraph-approvals";

// The chat with the Python agent server (agent-server/main.py), on TanStack AI's
// useChat: it reads the server's AG-UI events (ag-ui-langgraph) as they are.
// `persistence: true`: the server owns the chat. useChat loads it, and any approval
// still waiting, from GET /agent, and with `history` each send posts only the new
// turn (the checkpointer has the rest). This adds the context meter and approvals.

const REPLY_FAILED = "Something went wrong with that reply. Try again.";

export function useAgentChat({ url, threadId }: { url: string; threadId: string }) {
	// From the context_usage events of a reply: a reloaded chat shows none until the next.
	const [context, setContext] = useState<ContextUsage | null>(null);
	// "Thought for 4s": timed from the reasoning start and end events (main.py keeps
	// the text on the server). Seconds per reply, keyed by the user message it
	// answers. Live only: a reloaded chat has no timing.
	const [thoughts, setThoughts] = useState<ReadonlyMap<string, number>>(new Map());
	const [thinkingFor, setThinkingFor] = useState<string | null>(null);
	const thought = useRef<{ key: string; start: number } | null>(null);
	const lastUser = useRef<string | undefined>(undefined);

	const connection = useMemo(() => fetchServerSentEvents(url), [url]);
	const chat = useChat({
		connection,
		threadId,
		persistence: true,
		history: { pageSize: 50 },
		onCustomEvent: (name, data) => name === "context_usage" && setContext(data as ContextUsage),
		onChunk: (chunk) => {
			if (chunk.type === "REASONING_MESSAGE_START" && lastUser.current) {
				thought.current = { key: lastUser.current, start: Date.now() };
				setThinkingFor(lastUser.current);
			}
			if (chunk.type === "REASONING_MESSAGE_END" && thought.current) {
				const { key, start } = thought.current;
				// At least 1s, so a quick thought still reads right.
				const seconds = Math.max(1, Math.round((Date.now() - start) / 1000));
				setThoughts((m) => new Map(m).set(key, (m.get(key) ?? 0) + seconds));
				thought.current = null;
				setThinkingFor(null);
			}
		},
		onError: (e) => console.error("Agent run failed:", e),
	});
	const { messages, sendMessage, resumeInterruptsUnsafe, stop, isLoading } = chat;
	// The user's answer per tool call (true: approved). The approvals are off
	// TanStack's documented path: see langgraph-approvals.ts.
	const [decisions, setDecisions] = useState<ReadonlyMap<string, boolean>>(new Map());
	const approvals = useMemo(
		() => waitingApprovals(chat.interrupts as readonly AgentInterrupt[], decisions),
		[chat.interrupts, decisions],
	);

	useEffect(() => {
		lastUser.current = messages.findLast((m) => m.role === "user")?.id;
	}, [messages]);

	// main.py puts the thinking level into the agent's state.
	const send = useCallback(
		(text: string, thinkingLevel: ThinkingLevel) => sendMessage(text, { body: { thinkingLevel } }),
		[sendMessage],
	);

	// useChat's stop only closes this page's connection: the reply runs on in the
	// server (agent-server/runs.py, so leaving the page does not end it), so Stop
	// tells the server too.
	const stopReply = useCallback(() => {
		stop();
		fetch(`${url}/stop?threadId=${encodeURIComponent(threadId)}`, { method: "POST" }).catch(() => {});
	}, [stop, url, threadId]);

	// One answer for every waiting approval, through useChat's raw resume
	// (langgraph-approvals.ts says why).
	const answer = useCallback(
		(approved: boolean) => {
			setDecisions((m) => new Map([...m, ...approvals.map((a) => [a.toolCallId, approved] as const)]));
			return resumeInterruptsUnsafe(resumeItems(approvals, approved));
		},
		[approvals, resumeInterruptsUnsafe],
	);

	return {
		messages,
		approvals,
		decisions,
		context,
		loading: chat.isHydrating,
		running: isLoading,
		// Waiting for the first word of the reply.
		thinking: isLoading && messages.at(-1)?.role === "user",
		thoughts,
		// The reply (by its user message) the model is thinking in now. A stopped
		// reply sends no end event, so this only counts while one runs.
		reasoningFor: isLoading ? thinkingFor : null,
		error: chat.error ? new Error(REPLY_FAILED) : undefined,
		send,
		answer,
		stop: stopReply,
	};
}
