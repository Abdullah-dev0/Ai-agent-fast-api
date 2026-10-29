"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://127.0.0.1:8123/agent";

// TanStack's useChat, pointed straight at the Python agent server.
// Both speak AG-UI, so sending and streaming work with no Next.js route.
// `persistence: true` = the server owns the history. On page load useChat calls
// GET <AGENT_URL>?threadId=... and the Python server answers from LangGraph's
// checkpointer (agent-server/history.py), so a reload shows the chat again.
export function TanstackAgent({ threadId }: { threadId: string }) {
	const [input, setInput] = useState("");
	const bottomRef = useRef<HTMLDivElement>(null);

	const [clearing, startClear] = useTransition();
	const [answering, startAnswer] = useTransition();
	const { messages, sendMessage, isLoading, isHydrating, error, clear, stop, interrupts, resumeInterruptsUnsafe } = useChat({
		threadId,
		persistence: true,
		connection: fetchServerSentEvents(AGENT_URL),
	});

	// An assistant message is "empty" until its first reasoning, text or tool call arrives.
	const shown = (m: (typeof messages)[number]) =>
		m.role === "user" ||
		m.parts.some((p) => ((p.type === "text" || p.type === "thinking") && p.content) || p.type === "tool-call");
	const last = messages.at(-1);
	const thinking = isLoading && !(last?.role === "assistant" && shown(last));
	// The agent paused for approval (interrupt() in agent.py). These come from the
	// Python server, so TanStack lists them as "unbound": shown, but answered by us.
	const approvals = interrupts.filter((i) => i.reason === "tool-approval");

	function answer(approval: (typeof approvals)[number], approved: boolean) {
		startAnswer(async () => {
			// Sends AG-UI's `resume` field through this chat's own connection and
			// streams the continued reply right here: interrupt() in agent.py
			// returns { approved }. ("Unsafe" = TanStack's low-level escape hatch;
			// its safer bound methods only work for interrupts its own JS server made.)
			await resumeInterruptsUnsafe([{ interruptId: approval.id, status: "resolved", payload: { approved } }]);
			// The server deleted the thread; empty the screen too, or the next
			// message would send the old ones back.
			const raw = approval.metadata?.langgraph as { raw?: { tool?: string } } | undefined;
			if (approved && raw?.raw?.tool === "delete_chat_history") clear();
		});
	}

	function submit(e: React.FormEvent) {
		e.preventDefault();
		const text = input.trim();
		if (!text || isLoading || approvals.length > 0) return;
		sendMessage(text);
		setInput("");
	}

	function stopReply() {
		// useChat's stop() only closes this browser's connection; the reply keeps
		// running on the server (runs.py). This asks the server to stop it too.
		stop();
		void fetch(`${AGENT_URL}/stop?threadId=${encodeURIComponent(threadId)}`, { method: "POST" });
	}

	function clearChat() {
		if (!confirm("Clear this chat? This cannot be undone.")) return;
		startClear(async () => {
			// Delete the thread from the agent's memory (DELETE /agent in main.py),
			// otherwise the next reload would load it right back.
			await fetch(`${AGENT_URL}?threadId=${encodeURIComponent(threadId)}`, { method: "DELETE" });
			clear(); // and empty the screen
		});
	}

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
	}, [messages.length, last, thinking]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex justify-end">
				<button
					type="button"
					onClick={clearChat}
					// A streaming reply would save itself back after the clear.
					disabled={clearing || isLoading || isHydrating || messages.length === 0}
					className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:hover:bg-red-950">
					{clearing ? "Clearing…" : "Clear chat"}
				</button>
			</div>
			<ul className="flex flex-col gap-3">
				{messages.filter(shown).map((message) => (
					<li
						key={message.id}
						className={
							message.role === "user"
								? "self-end rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
								: "self-start rounded-lg border border-zinc-200 px-3 py-2 text-sm whitespace-pre-wrap dark:border-zinc-800"
						}>
						{message.parts.map((part, i) => {
							if (part.type === "text") return <span key={i}>{part.content}</span>;
							if (part.type === "thinking")
								// Gemini's reasoning summary: streamed live as REASONING events,
								// restored after a reload by history.py.
								return (
									<details key={i} className="mb-1 text-xs text-zinc-500">
										<summary className="cursor-pointer">Reasoning</summary>
										<span className="block whitespace-pre-wrap">{part.content}</span>
									</details>
								);
							if (part.type === "tool-call") {
								// useChat fills `output` from the TOOL_CALL_RESULT event (live) and
								// history.py fills it after a reload, so one field covers both.
								const output = part.output;
								// No result yet: either paused for the user's approval, or still running.
								const status =
									output !== undefined ? "Used" : approvals.length > 0 ? "Waiting for approval:" : "Running";
								const hasInput = part.arguments && part.arguments !== "{}";
								return (
									<span
										key={i}
										className="mb-1 block rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 dark:border-zinc-800">
										<span className="font-medium">
											{status} {part.name}
										</span>
										{hasInput && <span className="block font-mono">input: {part.arguments}</span>}
										{output !== undefined && <span className="block font-mono">output: {String(output)}</span>}
									</span>
								);
							}
							return null;
						})}
					</li>
				))}
				{thinking && (
					<li className="self-start animate-pulse rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-800">
						Thinking…
					</li>
				)}
				{isHydrating ? (
					<li className="animate-pulse text-sm text-zinc-500">Loading chat…</li>
				) : (
					messages.length === 0 && !thinking && <li className="text-sm text-zinc-500">No messages yet.</li>
				)}
			</ul>

			{approvals.map((approval) => (
				<div
					key={approval.id}
					className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
					<span>{approval.message ?? "The agent needs your approval to continue."}</span>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => answer(approval, true)}
							disabled={answering}
							className="rounded-md bg-red-600 px-3 py-1.5 text-white disabled:opacity-50">
							Approve
						</button>
						<button
							type="button"
							onClick={() => answer(approval, false)}
							disabled={answering}
							className="rounded-md border border-amber-400 px-3 py-1.5 disabled:opacity-50 dark:border-amber-700">
							Deny
						</button>
					</div>
				</div>
			))}

			{error && <p className="text-sm text-red-600">{error.message}</p>}

			<form onSubmit={submit} className="flex gap-2">
				<input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder="Ask about the time, the weather, or some math"
					className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
				/>
				{isLoading ? (
					<button
						type="button"
						onClick={stopReply}
						className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
						Stop
					</button>
				) : (
					<button
						type="submit"
						disabled={!input.trim() || isHydrating || approvals.length > 0}
						className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
						Send
					</button>
				)}
			</form>
			<div ref={bottomRef} />
		</div>
	);
}
