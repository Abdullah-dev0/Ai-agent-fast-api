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

// Our own chat hook for the Python agent server (agent-server/main.py).
// The server streams AG-UI events (https://docs.ag-ui.com); @ag-ui/client's
// HttpAgent reads them and this hook turns them into messages. It sends only the
// new message: the server keeps the whole conversation in its checkpointer,
// keyed by threadId.

// The same shapes agent-server/history.py returns, so a reloaded chat looks like
// a live one. One assistant message per reply; its parts in the order they came.
export type Part =
	| { type: "text"; id: string; text: string }
	| { type: "reasoning"; id: string; text: string }
	// No `result`: the tool has not run (yet).
	| { type: "tool"; id: string; name: string; args?: string; result?: string };

// Tokens a reply used, over all its model calls. Missing if the provider reported none.
export type Usage = { input: number; output: number };

export type ChatMessage = { id: string; role: "user" | "assistant"; parts: Part[]; usage?: Usage };

// How full the model's context is after its latest call (context_usage in
// agent-server/agent.py). limit is null when the model's limit is not known.
export type ContextUsage = { used: number; limit: number | null };

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

// What paused the run: LangChain's approval request, which the adapter keeps in an
// AG-UI interrupt's metadata.langgraph.raw (GET /agent returns the same shape). The
// interrupt itself carries the id and toolCallId.
type ApprovalRequest = { name: string; args: Record<string, unknown>; description: string };

function toApprovals(interrupts: Interrupt[]): Approval[] {
	return interrupts.flatMap((i) => {
		const raw: ApprovalRequest | undefined = i.metadata?.langgraph?.raw;
		if (!raw || !i.toolCallId) return [];
		return [{ id: i.id, toolCallId: i.toolCallId, name: raw.name, args: raw.args, description: raw.description }];
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

// The SDK accumulates the protocol transcript for us. Use its current assistant
// tool calls to fill arguments when the provider snapshot contains them but the
// stream did not send TOOL_CALL_ARGS deltas.
function applyToolArgs(parts: Part[], messages: readonly Message[]): Part[] {
	const args = new Map(
		messages
			.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
			.filter((call) => call.function.arguments.length > 0)
			.map((call) => [call.id, call.function.arguments] as const),
	);
	if (!parts.some((part) => part.type === "tool" && part.args === undefined && args.has(part.id))) return parts;
	return parts.map((part) =>
		part.type === "tool" && part.args === undefined ? { ...part, args: args.get(part.id) } : part,
	);
}

// Adds one streamed event to the parts of the reply. Returns the same array when
// the event changes nothing, so React skips the render.
function applyEvent(parts: Part[], event: AGUIEvent): Part[] {
	switch (event.type) {
		case EventType.TEXT_MESSAGE_CONTENT:
		case EventType.REASONING_MESSAGE_CONTENT: {
			const type = event.type === EventType.TEXT_MESSAGE_CONTENT ? "text" : "reasoning";
			const at = parts.findIndex((p) => p.type === type && p.id === event.messageId);
			if (at === -1) return [...parts, { type, id: event.messageId, text: event.delta }];
			return parts.map((p, i) => (i === at && p.type === type ? { ...p, text: p.text + event.delta } : p));
		}
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
	const [interrupts, setInterruptsState] = useState<Interrupt[]>([]);
	const [context, setContext] = useState<ContextUsage | null>(null);
	const [loading, setLoading] = useState(true); // loading the saved chat
	const [running, setRunning] = useState(false); // a reply is streaming
	const [started, setStarted] = useState(false); // the reply has shown something
	const [error, setError] = useState<Error>();
	// One agent per chat. Its own message list is only what the next run sends;
	// the page builds the messages it shows from the events.
	const agent = useMemo(() => new HttpAgent({ url, threadId }), [url, threadId]);
	const interruptsRef = useRef<Interrupt[]>([]);
	const setInterrupts = useCallback((next: Interrupt[]) => {
		interruptsRef.current = next;
		setInterruptsState(next);
	}, []);
	const approvals = useMemo(() => toApprovals(interrupts), [interrupts]);

	// The saved chat and any approval still waiting (GET /agent in main.py).
	// Next hides a chat you switch away from instead of unmounting it, so its reply
	// keeps streaming and this effect runs again when you come back. The saved copy
	// is behind that reply: leave the screen alone while one is running.
	useEffect(() => {
		if (agent.isRunning) return;
		const controller = new AbortController();
		fetch(`${url}?threadId=${encodeURIComponent(threadId)}`, { signal: controller.signal })
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Could not load the chat (${res.status})`))))
			.then((data: { messages: ChatMessage[]; context: ContextUsage | null; interrupts: Interrupt[] }) => {
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
	}, [agent, setInterrupts, url, threadId]);

	// The SDK parses, validates, and applies each protocol event. Map only the
	// typed events this UI displays into its richer message parts.
	const applyReplyEvent = useCallback((event: AGUIEvent, startsReply = false) => {
		if (startsReply) setStarted(true);
		setMessages((ms) => {
			const last = ms.at(-1);
			if (last?.role === "assistant") {
				const parts = applyEvent(last.parts, event);
				return parts === last.parts ? ms : [...ms.slice(0, -1), { ...last, parts }];
			}
			const parts = applyEvent([], event);
			return parts.length === 0 ? ms : [...ms, { id: crypto.randomUUID(), role: "assistant", parts }];
		});
	}, []);

	// Passed to each runAgent call as a per-run SDK subscriber.
	const subscriber = useMemo<AgentSubscriber>(
		() => ({
			onRunFinishedEvent: (p) => {
				if (p.outcome === "interrupt") setInterrupts(p.interrupts);
				const runUsage = p.event.usage;
				if (runUsage?.length) setMessages((ms) => addUsage(ms, runUsage));
			},
			// Stop arrives as a RUN_ERROR with code "abort": not an error.
			onRunErrorEvent: ({ event }) => {
				if (event.code !== "abort") setError(new Error(event.message));
			},
			onCustomEvent: ({ event }) => {
				if (event.name === "context_usage") setContext(event.value as ContextUsage);
			},
			// This fires after the SDK has applied each event to its protocol message
			// list, so snapshots and tool-call argument accumulation have one owner.
			onMessagesChanged: ({ messages }) => {
				setMessages((ms) => {
					const last = ms.at(-1);
					if (last?.role !== "assistant") return ms;
					const parts = applyToolArgs(last.parts, messages);
					return parts === last.parts ? ms : [...ms.slice(0, -1), { ...last, parts }];
				});
			},
			onTextMessageContentEvent: ({ event }) => applyReplyEvent(event, true),
			onReasoningMessageContentEvent: ({ event }) => applyReplyEvent(event, true),
			onToolCallStartEvent: ({ event }) => applyReplyEvent(event, true),
			onToolCallArgsEvent: ({ event }) => applyReplyEvent(event),
			onToolCallResultEvent: ({ event }) => applyReplyEvent(event),
		}),
		[applyReplyEvent, setInterrupts],
	);

	// One run: HttpAgent POSTs an AG-UI RunAgentInput and hands the events it
	// streams back to the subscriber.
	const run = useCallback(
		async (input: {
			messages: { id: string; role: "user"; content: string }[];
			resume?: ResumeEntry[];
			state?: { thinking_level: ThinkingLevel };
		}) => {
			setRunning(true);
			setStarted(false);
			setError(undefined);
			setInterrupts([]);
			// HttpAgent sends its whole message list and state every run: set them to
			// just this run's, since the server keeps the rest.
			agent.setMessages(input.messages);
			agent.setState(input.state ?? {});
			try {
				await agent.runAgent({ resume: input.resume }, subscriber);
			} catch (e) {
				setError(e instanceof Error ? e : new Error(String(e)));
			} finally {
				setRunning(false);
			}
		},
		[agent, setInterrupts, subscriber],
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
	// cover all open interrupts, and a model can ask for two tools at once, but that
	// is rare enough not to need a button per tool.
	const answer = useCallback(
		(approved: boolean) => {
			const open = interruptsRef.current;
			const responses: ResumeResponses = {};
			for (const i of open)
				responses[i.id] = { status: "resolved", payload: { type: approved ? "approve" : "reject" } };
			return run({ messages: [], resume: buildResumeArray(open, responses) });
		},
		[run],
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
	}, [agent, setInterrupts, url, threadId]);

	return {
		messages,
		approvals,
		context,
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
