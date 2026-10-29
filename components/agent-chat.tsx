"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useAgentChat, type ChatMessage } from "@/lib/use-agent-chat";

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://127.0.0.1:8123/agent";

// The chat UI for the Python agent server. All the talking to the server
// (streaming, approvals, history, stop) is in useAgentChat.
export function AgentChat({ threadId }: { threadId: string }) {
	const [input, setInput] = useState("");
	const bottomRef = useRef<HTMLDivElement>(null);
	const [clearing, startClear] = useTransition();
	const [answering, startAnswer] = useTransition();
	const { messages, approvals, loading, running, thinking, error, send, answer, stop, clear } = useAgentChat({
		url: AGENT_URL,
		threadId,
	});

	function decide(approved: boolean) {
		startAnswer(async () => {
			const deleting = approvals.some((a) => a.name === "delete_chat_history");
			await answer(approved);
			// The tool only says "approved"; the thread is deleted now that the
			// reply has ended, so the agent was not still writing to it.
			if (approved && deleting) await clear();
		});
	}

	function submit(e: React.FormEvent) {
		e.preventDefault();
		const text = input.trim();
		if (!text || running || approvals.length > 0) return;
		void send(text);
		setInput("");
	}

	function clearChat() {
		if (!confirm("Clear this chat? This cannot be undone.")) return;
		startClear(clear);
	}

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
	}, [messages, thinking, approvals]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex justify-end">
				<button
					type="button"
					onClick={clearChat}
					// A streaming reply would save itself back after the clear.
					disabled={clearing || running || loading || messages.length === 0}
					className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:hover:bg-red-950">
					{clearing ? "Clearing…" : "Clear chat"}
				</button>
			</div>
			<ul className="flex flex-col gap-3">
				{messages.map((message) => (
					<li
						key={message.id}
						className={
							message.role === "user"
								? "self-end rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
								: "self-start rounded-lg border border-zinc-200 px-3 py-2 text-sm whitespace-pre-wrap dark:border-zinc-800"
						}>
						<MessageParts message={message} waiting={approvals.map((a) => a.toolCallId)} running={running} />
					</li>
				))}
				{thinking && (
					<li className="self-start animate-pulse rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-800">
						Thinking…
					</li>
				)}
				{loading ? (
					<li className="animate-pulse text-sm text-zinc-500">Loading chat…</li>
				) : (
					messages.length === 0 && !thinking && <li className="text-sm text-zinc-500">No messages yet.</li>
				)}
			</ul>

			{approvals.length > 0 && (
				<div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
					{approvals.map((approval) => (
						<span key={approval.id}>{approval.description || "The agent needs your approval to continue."}</span>
					))}
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => decide(true)}
							disabled={answering}
							className="rounded-md bg-red-600 px-3 py-1.5 text-white disabled:opacity-50">
							Approve
						</button>
						<button
							type="button"
							onClick={() => decide(false)}
							disabled={answering}
							className="rounded-md border border-amber-400 px-3 py-1.5 disabled:opacity-50 dark:border-amber-700">
							Deny
						</button>
					</div>
				</div>
			)}

			{error && <p className="text-sm text-red-600">{error.message}</p>}

			<form onSubmit={submit} className="flex gap-2">
				<input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder="Ask about the time, the weather, or some math"
					className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
				/>
				{running ? (
					<button
						type="button"
						// Closes the request, which also stops the reply on the server.
						onClick={stop}
						className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
						Stop
					</button>
				) : (
					<button
						type="submit"
						disabled={!input.trim() || loading || approvals.length > 0}
						className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
						Send
					</button>
				)}
			</form>
			<div ref={bottomRef} />
		</div>
	);
}

function MessageParts({ message, waiting, running }: { message: ChatMessage; waiting: string[]; running: boolean }) {
	return message.parts.map((part) => {
		if (part.type === "text") return <span key={part.id}>{part.text}</span>;
		if (part.type === "reasoning")
			// Gemini's reasoning summary: streamed live, restored after a reload by history.py.
			return (
				<details key={part.id} className="mb-1 text-xs text-zinc-500">
					<summary className="cursor-pointer">Reasoning</summary>
					<span className="block whitespace-pre-wrap">{part.text}</span>
				</details>
			);
		// No result: waiting for approval, still running, or denied (a denial
		// streams no result; a reload shows the reason).
		const status =
			part.result !== undefined
				? "Used"
				: waiting.includes(part.id)
					? "Waiting for approval:"
					: running
						? "Running"
						: "Not run:";
		const hasInput = part.args && part.args !== "{}";
		return (
			<span
				key={part.id}
				className="mb-1 block rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 dark:border-zinc-800">
				<span className="font-medium">
					{status} {part.name}
				</span>
				{hasInput && <span className="block font-mono">input: {part.args}</span>}
				{part.result !== undefined && <span className="block font-mono">output: {part.result}</span>}
			</span>
		);
	});
}
