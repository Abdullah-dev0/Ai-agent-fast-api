"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Our own chat hook for the Python agent server (agent-server/main.py).
// The server streams AG-UI events (https://docs.ag-ui.com); this hook turns them
// into messages. It sends only the new message: the server keeps the whole
// conversation in its checkpointer, keyed by threadId.

// The same shapes agent-server/history.py returns, so a reloaded chat looks like
// a live one. One assistant message per reply; its parts in the order they came.
export type Part =
	| { type: "text"; id: string; text: string }
	| { type: "reasoning"; id: string; text: string }
	// No `result`: the tool has not run (yet).
	| { type: "tool"; id: string; name: string; args?: string; result?: string };

export type ChatMessage = { id: string; role: "user" | "assistant"; parts: Part[] };

// How hard the model thinks before a reply: Gemini's levels (agent-server/agent.py).
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// A tool waiting for the user's OK (HumanInTheLoopMiddleware in agent.py).
export type Approval = {
	id: string;
	toolCallId: string;
	name: string;
	args: Record<string, unknown>;
	description: string;
};

// An AG-UI interrupt, as it arrives in RUN_FINISHED or from GET /agent. The
// middleware's request rides in metadata.langgraph.raw.
type Interrupt = {
	id: string;
	metadata?: {
		langgraph?: {
			raw?: { type?: string; tool_call_id: string; name: string; args: Record<string, unknown>; description: string };
		};
	};
};

// The AG-UI events this hook uses; it ignores the others (steps, state).
type AgUiEvent =
	| { type: "TEXT_MESSAGE_CONTENT" | "REASONING_MESSAGE_CONTENT"; messageId: string; delta: string }
	| { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
	| { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
	| { type: "TOOL_CALL_RESULT"; toolCallId: string; content: string }
	| { type: "MESSAGES_SNAPSHOT"; messages: { toolCalls?: { id: string; function: { arguments: string } }[] }[] }
	| { type: "RUN_FINISHED"; outcome?: { type: "success" } | { type: "interrupt"; interrupts: Interrupt[] } }
	| { type: "RUN_ERROR"; message: string };

type ResumeEntry = { interruptId: string; status: "resolved"; payload: { type: "approve" | "reject" } };

function toApprovals(interrupts: Interrupt[]): Approval[] {
	return interrupts.flatMap((i) => {
		const raw = i.metadata?.langgraph?.raw;
		if (raw?.type !== "tool_approval") return [];
		return [{ id: i.id, toolCallId: raw.tool_call_id, name: raw.name, args: raw.args, description: raw.description }];
	});
}

// Reads a text/event-stream body: events are separated by a blank line, and
// each carries its JSON on `data:` lines.
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgUiEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) return;
		buffer += decoder.decode(value, { stream: true });
		const blocks = buffer.split(/\r?\n\r?\n/);
		buffer = blocks.pop() ?? "";
		for (const block of blocks) {
			const data = block
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (data) yield JSON.parse(data) as AgUiEvent;
		}
	}
}

// Adds one streamed event to the parts of the reply. Returns the same array when
// the event changes nothing, so React skips the render.
function applyEvent(parts: Part[], event: AgUiEvent): Part[] {
	switch (event.type) {
		case "TEXT_MESSAGE_CONTENT":
		case "REASONING_MESSAGE_CONTENT": {
			const type = event.type === "TEXT_MESSAGE_CONTENT" ? "text" : "reasoning";
			const at = parts.findIndex((p) => p.type === type && p.id === event.messageId);
			if (at === -1) return [...parts, { type, id: event.messageId, text: event.delta }];
			return parts.map((p, i) => (i === at && p.type === type ? { ...p, text: p.text + event.delta } : p));
		}
		case "TOOL_CALL_START":
			if (parts.some((p) => p.type === "tool" && p.id === event.toolCallId)) return parts;
			return [...parts, { type: "tool", id: event.toolCallId, name: event.toolCallName }];
		case "TOOL_CALL_ARGS":
			return parts.map((p) =>
				p.type === "tool" && p.id === event.toolCallId ? { ...p, args: (p.args ?? "") + event.delta } : p,
			);
		case "TOOL_CALL_RESULT":
			return parts.map((p) => (p.type === "tool" && p.id === event.toolCallId ? { ...p, result: event.content } : p));
		case "MESSAGES_SNAPSHOT": {
			// The adapter sends no TOOL_CALL_ARGS for Gemini (its first chunk holds
			// the name and the arguments together), so take the arguments from the
			// end-of-run snapshot. Nothing else is read from it.
			const args = new Map(
				event.messages.flatMap((m) => m.toolCalls ?? []).map((c) => [c.id, c.function.arguments] as const),
			);
			if (!parts.some((p) => p.type === "tool" && p.args === undefined && args.has(p.id))) return parts;
			return parts.map((p) => (p.type === "tool" && p.args === undefined ? { ...p, args: args.get(p.id) } : p));
		}
		default:
			return parts;
	}
}

export function useAgentChat({ url, threadId }: { url: string; threadId: string }) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [approvals, setApprovals] = useState<Approval[]>([]);
	const [loading, setLoading] = useState(true); // loading the saved chat
	const [running, setRunning] = useState(false); // a reply is streaming
	const [started, setStarted] = useState(false); // the reply has shown something
	const [error, setError] = useState<Error>();
	const abortRef = useRef<AbortController | null>(null);

	// The saved chat and any approval still waiting (GET /agent in main.py).
	useEffect(() => {
		const controller = new AbortController();
		fetch(`${url}?threadId=${encodeURIComponent(threadId)}`, { signal: controller.signal })
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Could not load the chat (${res.status})`))))
			.then((data: { messages: ChatMessage[]; interrupts: Interrupt[] }) => {
				setMessages(data.messages);
				setApprovals(toApprovals(data.interrupts));
			})
			.catch((e: unknown) => {
				if (!controller.signal.aborted) setError(e instanceof Error ? e : new Error(String(e)));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [url, threadId]);

	// One run: POST an AG-UI RunAgentInput and apply the events it streams back.
	const run = useCallback(
		async (input: {
			messages: { id: string; role: "user"; content: string }[];
			resume?: ResumeEntry[];
			state?: { thinking_level: ThinkingLevel };
		}) => {
			const controller = new AbortController();
			abortRef.current = controller;
			setRunning(true);
			setStarted(false);
			setError(undefined);
			setApprovals([]);
			try {
				const res = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
					body: JSON.stringify({
						threadId,
						runId: crypto.randomUUID(),
						state: {},
						tools: [],
						context: [],
						forwardedProps: {},
						...input,
					}),
					signal: controller.signal,
				});
				if (!res.ok || !res.body) throw new Error(`The agent server answered ${res.status}`);
				for await (const event of readEvents(res.body)) {
					if (event.type === "RUN_FINISHED") {
						if (event.outcome?.type === "interrupt") setApprovals(toApprovals(event.outcome.interrupts));
					} else if (event.type === "RUN_ERROR") {
						setError(new Error(event.message));
					} else {
						// Only something the page shows ends "Thinking…", not step events.
						if (
							event.type === "TEXT_MESSAGE_CONTENT" ||
							event.type === "REASONING_MESSAGE_CONTENT" ||
							event.type === "TOOL_CALL_START"
						)
							setStarted(true);
						// Events go to the reply being written: the last message if it is
						// the assistant's (a resumed run continues it), else a new one.
						setMessages((ms) => {
							const last = ms.at(-1);
							if (last?.role === "assistant") {
								const parts = applyEvent(last.parts, event);
								return parts === last.parts ? ms : [...ms.slice(0, -1), { ...last, parts }];
							}
							const parts = applyEvent([], event);
							return parts.length === 0 ? ms : [...ms, { id: crypto.randomUUID(), role: "assistant", parts }];
						});
					}
				}
			} catch (e) {
				// Stop aborts the request on purpose: not an error.
				if (!controller.signal.aborted) setError(e instanceof Error ? e : new Error(String(e)));
			} finally {
				if (abortRef.current === controller) abortRef.current = null;
				setRunning(false);
			}
		},
		[url, threadId],
	);

	const send = useCallback(
		(text: string, thinkingLevel: ThinkingLevel) => {
			const id = crypto.randomUUID();
			setMessages((ms) => [...ms, { id, role: "user", parts: [{ type: "text", id, text }] }]);
			return run({ messages: [{ id, role: "user", content: text }], state: { thinking_level: thinkingLevel } });
		},
		[run],
	);

	// Answers every waiting approval with one decision: AG-UI requires a resume to
	// cover all open interrupts, and only delete_chat_history asks, so there is
	// at most one in practice.
	const answer = useCallback(
		(approved: boolean) =>
			run({
				messages: [],
				resume: approvals.map((a) => ({
					interruptId: a.id,
					status: "resolved",
					payload: { type: approved ? "approve" : "reject" },
				})),
			}),
		[run, approvals],
	);

	// Closing the request stops the reply on the server too (main.py).
	const stop = useCallback(() => abortRef.current?.abort(), []);

	// Deletes the thread on the server (DELETE /agent), then empties the screen.
	const clear = useCallback(async () => {
		const res = await fetch(`${url}?threadId=${encodeURIComponent(threadId)}`, { method: "DELETE" });
		if (!res.ok) {
			setError(new Error(`Could not clear the chat (${res.status})`));
			return;
		}
		setMessages([]);
		setApprovals([]);
	}, [url, threadId]);

	return {
		messages,
		approvals,
		loading,
		running,
		// Waiting for the first piece of the reply.
		thinking: running && !started,
		error,
		send,
		answer,
		stop,
		clear,
	};
}
