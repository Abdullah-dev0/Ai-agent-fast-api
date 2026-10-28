"use client";

import { useState } from "react";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://127.0.0.1:8123/agent";

// The same useChat as /chat, but pointed straight at the Python agent server.
// Both speak AG-UI, so sending and streaming work with no Next.js route.
// No `persistence: true`: that loads history with GET ?threadId=, which the
// Python server does not have. The agent still remembers the thread
// (checkpointer), but this page shows an empty chat after a reload.
export function TanstackAgent({ threadId }: { threadId: string }) {
	const [input, setInput] = useState("");
	const { messages, sendMessage, isLoading, error } = useChat({
		threadId,
		connection: fetchServerSentEvents(AGENT_URL),
	});

	function submit(e: React.FormEvent) {
		e.preventDefault();
		const text = input.trim();
		if (!text || isLoading) return;
		sendMessage(text);
		setInput("");
	}

	return (
		<div className="flex flex-col gap-4">
			<ul className="flex flex-col gap-3">
				{messages.map((message) => (
					<li
						key={message.id}
						className={
							message.role === "user"
								? "self-end rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
								: "self-start rounded-lg border border-zinc-200 px-3 py-2 text-sm whitespace-pre-wrap dark:border-zinc-800"
						}>
						{message.parts.map((part, i) => {
							if (part.type === "text") return <span key={i}>{part.content}</span>;
							if (part.type === "tool-call")
								return (
									<span key={i} className="block text-xs text-zinc-500">
										Used {part.name}
									</span>
								);
							return null;
						})}
					</li>
				))}
				{messages.length === 0 && <li className="text-sm text-zinc-500">No messages yet.</li>}
			</ul>

			{error && <p className="text-sm text-red-600">{error.message}</p>}

			<form onSubmit={submit} className="flex gap-2">
				<input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder="Ask about the time, the weather, or some math"
					className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
				/>
				<button
					type="submit"
					disabled={!input.trim() || isLoading}
					className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
					{isLoading ? "…" : "Send"}
				</button>
			</form>
		</div>
	);
}
