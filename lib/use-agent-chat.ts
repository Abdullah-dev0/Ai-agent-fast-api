"use client";

import { buildResumeArray, HttpAgent, type AgentSubscriber } from "@ag-ui/client";
import {
	contentToText,
	EventType,
	type AGUIEvent,
	type Interrupt,
	type Message,
	type ResumeEntry,
	type TokenUsage,
} from "@ag-ui/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseApprovalCard } from "./agent-tools";
import type {
	Approval,
	ApprovalRequest,
	ChatMessage,
	ContextUsage,
	Part,
	SavedChat,
	ThinkingLevel,
} from "./chat-types";

// Our own chat hook for the Python agent server (agent-server/main.py).
// The server streams AG-UI events (https://docs.ag-ui.com); @ag-ui/client's
// HttpAgent reads them and this hook turns them into messages. It sends only the
// new message: the server keeps the whole conversation in its checkpointer,
// keyed by threadId. The shapes it uses are in chat-types.ts.

function toApprovals(interrupts: Interrupt[]): Approval[] {
	return interrupts.flatMap((i) => {
		const raw: ApprovalRequest | undefined = i.metadata?.langgraph?.raw;
		if (raw?.type !== "tool_approval") return [];
		return [
			{ id: i.id, toolCallId: i.toolCallId ?? "", name: raw.name, args: raw.args, card: parseApprovalCard(raw.description) },
		];
	});
}

// Adds a finished run's tokens to the reply. A run resumed after an approval
// continues the same message, so its tokens add to the earlier ones.
function addUsage(messages: ChatMessage[], runUsage: TokenUsage[]): ChatMessage[] {
	const last = messages.at(-1);
	if (last?.role !== "assistant") return messages;
	const usage = runUsage.reduce(
		(sum, u) => ({ input: sum.input + (u.inputTokens ?? 0), output: sum.output + (u.outputTokens ?? 0) }),
		last.usage ?? { input: 0, output: 0 },
	);
	return [...messages.slice(0, -1), { ...last, usage }];
}

// Fills in what only the end-of-run MESSAGES_SNAPSHOT (the whole thread) carries:
// Gemini streams no TOOL_CALL_ARGS, a denied tool's result is never streamed, and
// only the snapshot says a result is a failure (`error`; TOOL_CALL_RESULT has none).
function fillFromSnapshot(parts: Part[], messages: readonly Message[]): Part[] {
	const args = new Map<string, string>();
	const results = new Map<string, string>();
	const failed = new Set<string>();
	for (const m of messages) {
		if (m.role === "assistant") for (const call of m.toolCalls ?? []) args.set(call.id, call.function.arguments);
		if (m.role === "tool") {
			results.set(m.toolCallId, contentToText(m.content));
			if (m.error) failed.add(m.toolCallId);
		}
	}
	const filled = parts.map((p) => {
		if (p.type !== "tool") return p;
		const next = {
			...p,
			args: p.args ?? (args.get(p.id) || undefined),
			result: p.result ?? results.get(p.id),
			failed: p.failed ?? (failed.has(p.id) || undefined),
		};
		return next.args === p.args && next.result === p.result && next.failed === p.failed ? p : next;
	});
	return filled.some((p, i) => p !== parts[i]) ? filled : parts;
}

// Adds one streamed event to the parts of the reply. Returns the same array when
// the event changes nothing, so React skips the render. The SDK keeps its own copy
// of the thread too, but its order breaks once a snapshot arrives, so the page
// builds the reply here, from the events alone. `now` is when the event came,
// read by the caller so this stays pure.
function applyEvent(parts: Part[], event: AGUIEvent, now: number): Part[] {
	switch (event.type) {
		case EventType.TEXT_MESSAGE_CONTENT: {
			const at = parts.findIndex((p) => p.type === "text" && p.id === event.messageId);
			if (at === -1) return [...parts, { type: "text", id: event.messageId, text: event.delta }];
			return parts.map((p, i) => (i === at && p.type === "text" ? { ...p, text: p.text + event.delta } : p));
		}
		// Reasoning comes as a start and an end only: main.py keeps its text on the server.
		case EventType.REASONING_MESSAGE_START:
			if (parts.some((p) => p.type === "reasoning" && p.id === event.messageId)) return parts;
			return [...parts, { type: "reasoning", id: event.messageId, startedAt: now }];
		case EventType.REASONING_MESSAGE_END:
			// "Thought for 4s": rounded, and at least 1s so a quick thought still reads right.
			return parts.map((p) =>
				p.type === "reasoning" && p.id === event.messageId && p.startedAt !== undefined && p.seconds === undefined
					? { ...p, seconds: Math.max(1, Math.round((now - p.startedAt) / 1000)) }
					: p,
			);
		case EventType.MESSAGES_SNAPSHOT:
			return fillFromSnapshot(parts, event.messages);
		case EventType.TOOL_CALL_START:
			// A resumed run starts the paused call again and resends its arguments, so
			// clear the first copy. The end-of-run snapshot fills them in if none come.
			if (parts.some((p) => p.type === "tool" && p.id === event.toolCallId))
				return parts.map((p) => (p.type === "tool" && p.id === event.toolCallId ? { ...p, args: undefined } : p));
			return [...parts, { type: "tool", id: event.toolCallId, name: event.toolCallName }];
		case EventType.TOOL_CALL_ARGS:
			return parts.map((p) =>
				p.type === "tool" && p.id === event.toolCallId ? { ...p, args: (p.args ?? "") + event.delta } : p,
			);
		case EventType.TOOL_CALL_RESULT:
			// AG-UI allows a list of content parts; the server sends a string today.
			return parts.map((p) =>
				p.type === "tool" && p.id === event.toolCallId ? { ...p, result: contentToText(event.content) } : p,
			);
		default:
			return parts;
	}
}

type ResumeResponses = Parameters<typeof buildResumeArray>[1];

// What the page shows when a reply fails. The server's own message (a Python
// exception, a provider error) goes to the console, not to the user.
const REPLY_FAILED = "Something went wrong with that reply. Try again.";

function replyFailed(detail: unknown): Error {
	console.error("Agent run failed:", detail);
	return new Error(REPLY_FAILED);
}

// The SDK remembers live interrupts on the agent instance. The server thread was
// deleted, so discard that protocol state before starting over.
function forgetThread(agent: HttpAgent) {
	agent.pendingInterrupts = [];
	agent.setMessages([]);
	agent.setState({});
}

export function useAgentChat({ url, threadId }: { url: string; threadId: string }) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	// What the run is paused on, as AG-UI sent it.
	const [interrupts, setInterrupts] = useState<Interrupt[]>([]);
	const [context, setContext] = useState<ContextUsage | null>(null);
	const [loading, setLoading] = useState(true); // loading the saved chat
	const [running, setRunning] = useState(false); // a reply is streaming
	const [started, setStarted] = useState(false); // the reply has shown something
	const [error, setError] = useState<Error>();
	// One agent per chat. Its own message list is only what the next run sends;
	// the page builds the messages it shows from the events (applyEvent).
	const agent = useMemo(() => new HttpAgent({ url, threadId }), [url, threadId]);
	const approvals = useMemo(() => toApprovals(interrupts), [interrupts]);
	// Set when a run ends with RUN_FINISHED and no approval left to answer; run() reads it.
	const finished = useRef(false);

	// The saved chat and any approval still waiting (GET /agent in main.py).
	// Next hides a chat you switch away from instead of unmounting it, so its reply
	// keeps streaming and this effect runs again when you come back. The saved copy
	// is behind that reply: leave the screen alone while one is running.
	useEffect(() => {
		if (agent.isRunning) return;
		const controller = new AbortController();
		fetch(`${url}?threadId=${encodeURIComponent(threadId)}`, { signal: controller.signal })
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Could not load the chat (${res.status})`))))
			.then((data: SavedChat) => {
				setMessages(data.messages);
				setContext(data.context);
				setInterrupts(data.interrupts);
			})
			.catch((e: unknown) => {
				if (!controller.signal.aborted) setError(e instanceof Error ? e : new Error(String(e)));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [agent, url, threadId]);

	// Passed to each runAgent call as a per-run SDK subscriber.
	const subscriber = useMemo<AgentSubscriber>(
		() => ({
			onRunFinishedEvent: (p) => {
				if (p.outcome === "interrupt") setInterrupts(p.interrupts);
				else finished.current = true;
				const runUsage = p.event.usage;
				if (runUsage?.length) setMessages((ms) => addUsage(ms, runUsage));
			},
			// Stop arrives as a RUN_ERROR with code "abort": not an error.
			onRunErrorEvent: ({ event }) => {
				if (event.code !== "abort") setError(replyFailed(event.message));
			},
			onCustomEvent: ({ event }) => {
				if (event.name === "context_usage") setContext(event.value as ContextUsage);
			},
			// The SDK has already parsed and validated the event; show the ones the page
			// displays. Only something it shows ends "Thinking…", not step events.
			onEvent: ({ event: e }) => {
				const event = e as AGUIEvent;
				if (
					event.type === EventType.TEXT_MESSAGE_CONTENT ||
					event.type === EventType.REASONING_MESSAGE_START ||
					event.type === EventType.TOOL_CALL_START
				)
					setStarted(true);
				const now = Date.now();
				setMessages((ms) => {
					const last = ms.at(-1);
					if (last?.role === "assistant") {
						const parts = applyEvent(last.parts, event, now);
						return parts === last.parts ? ms : [...ms.slice(0, -1), { ...last, parts }];
					}
					const parts = applyEvent([], event, now);
					return parts.length === 0 ? ms : [...ms, { id: crypto.randomUUID(), role: "assistant", parts }];
				});
			},
		}),
		[],
	);

	// One run: HttpAgent POSTs an AG-UI RunAgentInput and hands the events it
	// streams back to the subscriber. Resolves once the server has closed the stream,
	// with true if the reply completed. false: it failed, was stopped, or paused
	// for another approval.
	const run = useCallback(
		async (input: {
			messages: { id: string; role: "user"; content: string }[];
			resume?: ResumeEntry[];
			state?: { thinking_level: ThinkingLevel };
		}): Promise<boolean> => {
			setRunning(true);
			setStarted(false);
			setError(undefined);
			setInterrupts([]);
			finished.current = false;
			// HttpAgent sends its whole message list and state every run: set them to
			// just this run's, since the server keeps the rest.
			agent.setMessages(input.messages);
			agent.setState(input.state ?? {});
			try {
				await agent.runAgent({ resume: input.resume }, subscriber);
			} catch (e) {
				setError(replyFailed(e));
			} finally {
				setRunning(false);
			}
			return finished.current;
		},
		[agent, subscriber],
	);

	const send = useCallback(
		(text: string, thinkingLevel: ThinkingLevel) => {
			const id = crypto.randomUUID();
			setMessages((ms) => [...ms, { id, role: "user", parts: [{ type: "text", id, text }] }]);
			return run({ messages: [{ id, role: "user", content: text }], state: { thinking_level: thinkingLevel } });
		},
		[run],
	);

	// Sends the user's decision for each waiting approval, by its id: approving one
	// tool never approves another. AG-UI requires a resume to cover every open
	// interrupt, so the page calls this once all have a decision. Resolves like
	// run(): true once the resumed reply has completed.
	const answer = useCallback(
		(decisions: ReadonlyMap<string, boolean>) => {
			const responses: ResumeResponses = {};
			for (const i of interrupts) {
				const approved = decisions.get(i.id);
				if (approved === undefined) throw new Error(`No decision for approval ${i.id}`);
				responses[i.id] = { status: "resolved", payload: { type: approved ? "approve" : "reject" } };
			}
			return run({ messages: [], resume: buildResumeArray(interrupts, responses) });
		},
		[run, interrupts],
	);

	// Closing the request stops the reply on the server too (main.py).
	const stop = useCallback(() => agent.abortRun(), [agent]);

	// Deletes the thread on the server (DELETE /agent), then empties the screen.
	// Returns whether it worked.
	const clear = useCallback(async () => {
		const res = await fetch(`${url}?threadId=${encodeURIComponent(threadId)}`, { method: "DELETE" });
		if (!res.ok) {
			setError(new Error(`Could not delete the chat (${res.status})`));
			return false;
		}
		setMessages([]);
		setInterrupts([]);
		setContext(null);
		forgetThread(agent);
		return true;
	}, [agent, url, threadId]);

	return {
		messages,
		approvals,
		context,
		loading,
		running,
		thinking: running && !started,
		error,
		send,
		answer,
		stop,
		clear,
	};
}
