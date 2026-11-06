"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { parseApprovalCard } from "./agent-tools";
import type { Approval, ChatMessage, ContextUsage, SavedChat, ThinkingLevel } from "./chat-types";

// The chat with the Python agent server (agent-server/main.py), on the AI SDK's
// useChat. The server streams the AI SDK's UI message stream (ui_stream.py), so
// useChat builds the messages itself. What this adds: the saved chat on load, the
// context meter, and approvals. It sends only what is new: the server keeps the
// whole conversation in its checkpointer, keyed by the chat id.

// What the page shows when a reply fails. The server sends this same sentence for
// its own errors; a network error's text would be no better for the user.
const REPLY_FAILED = "Something went wrong with that reply. Try again.";

// The tool calls in the newest reply that wait for the user's OK.
function waitingApprovals(message: ChatMessage | undefined): Approval[] {
	if (message?.role !== "assistant") return [];
	return message.parts.flatMap((p) =>
		p.type === "dynamic-tool" && p.state === "approval-requested"
			? [{ id: p.approval.id, toolCallId: p.toolCallId, name: p.toolName, card: parseApprovalCard(p.approval.requestReason ?? "") }]
			: [],
	);
}

export function useAgentChat({ url, threadId }: { url: string; threadId: string }) {
	const [context, setContext] = useState<ContextUsage | null>(null);
	const [loading, setLoading] = useState(true); // loading the saved chat
	const [loadError, setLoadError] = useState<Error>();
	// Set when a reply ends with nothing left to answer; answer() reads it.
	const completed = useRef(false);

	const transport = useMemo(
		() =>
			new DefaultChatTransport<ChatMessage>({
				api: url,
				// Only what is new (ChatRequest in main.py): the user's message, or
				// the answers to the approvals the run waits on.
				prepareSendMessagesRequest: ({ id, messages, body }) => {
					const last = messages.at(-1);
					if (last?.role === "assistant")
						return {
							body: {
								threadId: id,
								approvals: last.parts.flatMap((p) =>
									p.type === "dynamic-tool" && p.state === "approval-responded"
										? [{ id: p.approval.id, approved: p.approval.approved }]
										: [],
								),
							},
						};
					const text = last?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "";
					return { body: { threadId: id, messageId: last?.id, text, thinkingLevel: body?.thinkingLevel } };
				},
			}),
		[url],
	);

	const chat = useChat<ChatMessage>({
		id: threadId,
		transport,
		// Fewer renders while a long reply streams.
		experimental_throttle: 50,
		onData: (part) => {
			if (part.type === "data-context") setContext(part.data);
		},
		onError: (e) => console.error("Agent run failed:", e),
		onFinish: ({ message, isAbort, isDisconnect, isError }) => {
			completed.current = !isAbort && !isDisconnect && !isError && waitingApprovals(message).length === 0;
		},
	});
	const { messages, setMessages, status, sendMessage, addToolApprovalResponse, stop } = chat;
	const running = status === "submitted" || status === "streaming";
	const approvals = useMemo(() => waitingApprovals(messages.at(-1)), [messages]);

	// Read by the effect below, which must not re-run on every status change.
	const isRunning = useEffectEvent(() => running);

	// The saved chat and any approval still waiting (GET /agent in main.py).
	// Next hides a chat you switch away from instead of unmounting it, so its reply
	// keeps streaming and this effect runs again when you come back. The saved copy
	// is behind that reply: leave the screen alone while one is running.
	useEffect(() => {
		if (isRunning()) return;
		const controller = new AbortController();
		fetch(`${url}?threadId=${encodeURIComponent(threadId)}`, { signal: controller.signal })
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Could not load the chat (${res.status})`))))
			.then((data: SavedChat) => {
				setMessages(data.messages);
				setContext(data.context);
			})
			.catch((e: unknown) => {
				if (!controller.signal.aborted) setLoadError(e instanceof Error ? e : new Error(String(e)));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [url, threadId, setMessages]);

	const send = useCallback(
		(text: string, thinkingLevel: ThinkingLevel) => {
			setLoadError(undefined);
			return sendMessage({ text }, { body: { thinkingLevel } });
		},
		[sendMessage],
	);

	// Sends the user's decision for each waiting approval, by its id: approving one
	// tool never approves another. The server needs every one answered, so the page
	// calls this once all have a decision. Resolves once the resumed reply has ended,
	// with true if it completed (not failed, stopped, or paused for another approval).
	const answer = useCallback(
		async (decisions: ReadonlyMap<string, boolean>) => {
			for (const a of approvals) {
				const approved = decisions.get(a.id);
				if (approved === undefined) throw new Error(`No decision for approval ${a.id}`);
				await addToolApprovalResponse({ id: a.id, approved });
			}
			completed.current = false;
			// No message: useChat sends the reply with the answers in it.
			await sendMessage();
			return completed.current;
		},
		[approvals, addToolApprovalResponse, sendMessage],
	);

	// Deletes the thread on the server (DELETE /agent), then empties the screen.
	// Returns whether it worked.
	const clear = useCallback(async () => {
		const res = await fetch(`${url}?threadId=${encodeURIComponent(threadId)}`, { method: "DELETE" });
		if (!res.ok) {
			setLoadError(new Error(`Could not delete the chat (${res.status})`));
			return false;
		}
		setMessages([]);
		setContext(null);
		return true;
	}, [url, threadId, setMessages]);

	return {
		messages,
		approvals,
		context,
		loading,
		running,
		// Waiting for the first word of the reply.
		thinking: status === "submitted",
		error: loadError ?? (chat.error ? new Error(REPLY_FAILED) : undefined),
		send,
		answer,
		stop,
		clear,
	};
}
