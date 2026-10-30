"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { needsUser, runBrowserTool, type BrowserToolResult } from "./browser-tools";

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

// A tool the page has to run itself (get_location in agent-server/tools.py).
export type BrowserCall = { id: string; toolCallId: string; name: string; args: Record<string, unknown> };

// An AG-UI interrupt, as it arrives in RUN_FINISHED or from GET /agent. What paused
// the run rides in metadata.langgraph.raw: the middleware's request or a browser tool's.
type Interrupt = {
	id: string;
	metadata?: {
		langgraph?: {
			raw?: { type?: string; tool_call_id: string; name: string; args: Record<string, unknown>; description: string };
		};
	};
};

// A run's token counts, one entry per provider and model.
type RunUsage = { inputTokens?: number; outputTokens?: number };

// The AG-UI events this hook uses; it ignores the others (steps, state).
type AgUiEvent =
	| { type: "TEXT_MESSAGE_CONTENT" | "REASONING_MESSAGE_CONTENT"; messageId: string; delta: string }
	| { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
	| { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
	| { type: "TOOL_CALL_RESULT"; toolCallId: string; content: string }
	| { type: "MESSAGES_SNAPSHOT"; messages: { toolCalls?: { id: string; function: { arguments: string } }[] }[] }
	| {
			type: "RUN_FINISHED";
			outcome?: { type: "success" } | { type: "interrupt"; interrupts: Interrupt[] };
			usage?: RunUsage[];
	  }
	| { type: "CUSTOM"; name: string; value: unknown }
	| { type: "RUN_ERROR"; message: string };

type ResumeEntry = { interruptId: string; status: "resolved"; payload: { type: "approve" | "reject" } | BrowserToolResult };

function toApprovals(interrupts: Interrupt[]): Approval[] {
	return interrupts.flatMap((i) => {
		const raw = i.metadata?.langgraph?.raw;
		if (raw?.type !== "tool_approval") return [];
		return [{ id: i.id, toolCallId: raw.tool_call_id, name: raw.name, args: raw.args, description: raw.description }];
	});
}

function toBrowserCalls(interrupts: Interrupt[]): BrowserCall[] {
	return interrupts.flatMap((i) => {
		const raw = i.metadata?.langgraph?.raw;
		if (raw?.type !== "browser_tool") return [];
		return [{ id: i.id, toolCallId: raw.tool_call_id, name: raw.name, args: raw.args ?? {} }];
	});
}

// Adds a finished run's tokens to the reply. A run resumed after an approval
// continues the same message, so its tokens add to the earlier ones.
function addUsage(messages: ChatMessage[], runUsage: RunUsage[]): ChatMessage[] {
	const last = messages.at(-1);
	if (last?.role !== "assistant") return messages;
	const usage = runUsage.reduce(
		(sum, u) => ({ input: sum.input + (u.inputTokens ?? 0), output: sum.output + (u.outputTokens ?? 0) }),
		last.usage ?? { input: 0, output: 0 },
	);
	return [...messages.slice(0, -1), { ...last, usage }];
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
			// A resumed run starts the paused call again and resends its arguments, so
			// clear the first copy. The end-of-run snapshot fills them in if none come.
			if (parts.some((p) => p.type === "tool" && p.id === event.toolCallId))
				return parts.map((p) => (p.type === "tool" && p.id === event.toolCallId ? { ...p, args: undefined } : p));
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
	const [browserCalls, setBrowserCalls] = useState<BrowserCall[]>([]);
	const [context, setContext] = useState<ContextUsage | null>(null);
	const [loading, setLoading] = useState(true); // loading the saved chat
	const [running, setRunning] = useState(false); // a reply is streaming
	const [started, setStarted] = useState(false); // the reply has shown something
	const [error, setError] = useState<Error>();
	const abortRef = useRef<AbortController | null>(null);
	const startedCalls = useRef(new Set<string>()); // browser tools already run
	const callResults = useRef(new Map<string, BrowserToolResult>()); // their answers so far

	// The saved chat and any approval or browser tool still waiting (GET /agent in main.py).
	// Next hides a chat you switch away from instead of unmounting it, so its reply
	// keeps streaming and this effect runs again when you come back. The saved copy
	// is behind that reply: leave the screen alone while one is running.
	useEffect(() => {
		if (abortRef.current) return;
		const controller = new AbortController();
		fetch(`${url}?threadId=${encodeURIComponent(threadId)}`, { signal: controller.signal })
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Could not load the chat (${res.status})`))))
			.then((data: { messages: ChatMessage[]; context: ContextUsage | null; interrupts: Interrupt[] }) => {
				setMessages(data.messages);
				setContext(data.context);
				setApprovals(toApprovals(data.interrupts));
				setBrowserCalls(toBrowserCalls(data.interrupts));
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
			setBrowserCalls([]);
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
						if (event.outcome?.type === "interrupt") {
							setApprovals(toApprovals(event.outcome.interrupts));
							setBrowserCalls(toBrowserCalls(event.outcome.interrupts));
						}
						const runUsage = event.usage;
						if (runUsage?.length) setMessages((ms) => addUsage(ms, runUsage));
					} else if (event.type === "RUN_ERROR") {
						setError(new Error(event.message));
					} else if (event.type === "CUSTOM") {
						if (event.name === "context_usage") setContext(event.value as ContextUsage);
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

	// Saves one browser tool's answer. AG-UI requires a resume to cover all open
	// interrupts, so the run goes on once the last tool has answered. Approvals come
	// first (the middleware pauses before any tool runs), so none is left unanswered.
	const finishBrowserCall = useCallback(
		(id: string, result: BrowserToolResult) => {
			callResults.current.set(id, result);
			const resume = browserCalls.flatMap((c): ResumeEntry[] => {
				const payload = callResults.current.get(c.id);
				return payload ? [{ interruptId: c.id, status: "resolved", payload }] : [];
			});
			if (resume.length === browserCalls.length) void run({ messages: [], resume });
		},
		[browserCalls, run],
	);

	// Runs the tools that need no click. The same interrupt can arrive twice (coming
	// back to a hidden chat loads it again), and running it twice would ask the user
	// twice, hence startedCalls.
	useEffect(() => {
		for (const c of browserCalls) {
			if (needsUser(c.name) || startedCalls.current.has(c.id)) continue;
			startedCalls.current.add(c.id);
			void runBrowserTool(c.name, threadId, c.args).then((result) => finishBrowserCall(c.id, result));
		}
	}, [browserCalls, threadId, finishBrowserCall]);

	// Answers every waiting approval with one decision: AG-UI requires a resume to
	// cover all open interrupts, and a model can ask for two tools at once, but that
	// is rare enough not to need a button per tool.
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
	// Returns whether it worked.
	const clear = useCallback(async () => {
		const res = await fetch(`${url}?threadId=${encodeURIComponent(threadId)}`, { method: "DELETE" });
		if (!res.ok) {
			setError(new Error(`Could not delete the chat (${res.status})`));
			return false;
		}
		setMessages([]);
		setApprovals([]);
		setBrowserCalls([]);
		setContext(null);
		return true;
	}, [url, threadId]);

	return {
		messages,
		approvals,
		browserCalls,
		context,
		loading,
		running,
		// Waiting for the first piece of the reply.
		thinking: running && !started,
		error,
		send,
		answer,
		finishBrowserCall,
		stop,
		clear,
	};
}
