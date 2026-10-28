"use client";

import { useState, useTransition } from "react";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { deleteChat } from "@/lib/actions";

export function Chat({ threadId }: { threadId: string }) {
	const [input, setInput] = useState("");
	// persistence: true = the server is the source of truth. Nothing is kept in
	// the browser; on mount the hook GETs /api/chat?threadId=... and repaints.
	const [deleting, startDelete] = useTransition();
	const { messages, sendMessage, isLoading, isHydrating, error, stop, clear } = useChat({
		threadId,
		connection: fetchServerSentEvents("/api/chat"),
		persistence: true,
	});

	const hasText = (m: (typeof messages)[number]) => m.parts.some((p) => p.type === "text" && p.content);
	const last = messages.at(-1);
	// A reply is pending until the assistant's first visible text arrives. Reasoning
	// models can stream thinking first, so "status === submitted" alone is too short.
	const thinking = isLoading && !(last?.role === "assistant" && hasText(last));

	function submit(e: React.FormEvent) {
		e.preventDefault();
		const text = input.trim();
		if (!text || isLoading || isHydrating) return;
		sendMessage(text);
		setInput("");
	}

	function deleteAll() {
		if (!confirm("Delete this whole chat? This cannot be undone.")) return;
		startDelete(async () => {
			await deleteChat();
			clear();
		});
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex justify-end">
				<button
					type="button"
					onClick={deleteAll}
					// A streaming reply would save itself back after the delete.
					disabled={deleting || isLoading || isHydrating || messages.length === 0}
					className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:hover:bg-red-950"
				>
					{deleting ? "Deleting…" : "Delete chat"}
				</button>
			</div>

			<ul className="flex flex-col gap-3" aria-busy={isHydrating || thinking}>
				{messages.filter((m) => m.role === "user" || hasText(m)).map((message) => (
					<li
						key={message.id}
						className={
							message.role === "user"
								? "self-end rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
								: "self-start rounded-lg border border-zinc-200 px-3 py-2 text-sm whitespace-pre-wrap dark:border-zinc-800"
						}
					>
						{message.parts.map((part, i) => (part.type === "text" ? <span key={i}>{part.content}</span> : null))}
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
					messages.length === 0 && <li className="text-sm text-zinc-500">No messages yet.</li>
				)}
			</ul>

			{error && <p className="text-sm text-red-600">{error.message}</p>}

			<form onSubmit={submit} className="flex gap-2">
				<input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder="Say something, then reload the page"
					className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
				/>
				{isLoading ? (
					<button
						type="button"
						onClick={stop}
						className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
					>
						Stop
					</button>
				) : (
					<button
						type="submit"
						disabled={!input.trim() || isHydrating}
						className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
					>
						Send
					</button>
				)}
			</form>
		</div>
	);
}
