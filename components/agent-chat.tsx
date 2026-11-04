"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteChat, touchChat } from "@/lib/actions";
import { THINKING_LEVELS, useAgentChat, type ThinkingLevel } from "@/lib/use-agent-chat";
import { AssistantMessage } from "./chat/assistant-message";
import { Composer } from "./chat/composer";
import { ContextMeter } from "./chat/context-meter";
import { TrashIcon } from "./chat/icons";

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://127.0.0.1:8123/agent";
const THINKING_KEY = "agent-chat-thinking";

// The level picked last time. The server has no localStorage and gets the default,
// which is safe: the selector only renders after the chat has loaded in the browser.
function savedThinking(): ThinkingLevel {
	try {
		const saved = localStorage.getItem(THINKING_KEY);
		return THINKING_LEVELS.find((level) => level === saved) ?? "medium";
	} catch {
		return "medium";
	}
}

// The chat UI for the Python agent server. All the talking to the server
// (streaming, approvals, history, stop) is in useAgentChat.
export function AgentChat({ threadId }: { threadId: string }) {
	const router = useRouter();
	const [input, setInput] = useState("");
	const [thinkingLevel, setThinkingLevel] = useState(savedThinking);
	const [deleting, startDelete] = useTransition();
	const [answering, startAnswer] = useTransition();
	const {
		messages,
		approvals,
		context,
		loading,
		running,
		thinking,
		error,
		send,
		answer,
		stop,
		clear,
	} = useAgentChat({
		url: AGENT_URL,
		threadId,
	});
	// The run is paused until the user answers: a new message would not fit.
	const paused = approvals.length > 0;

	// Follow the reply as it streams, but only while the user is at the bottom:
	// scrolling up to read stops the following.
	const atBottom = useRef(true);
	const scroller = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = scroller.current;
		if (el && atBottom.current) el.scrollTo({ top: el.scrollHeight });
	}, [messages, thinking, approvals, loading]);

	// The thread first: if that fails, the chat stays in the list.
	async function removeChat() {
		if (await clear()) await deleteChat(threadId);
	}

	function decide(approved: boolean) {
		startAnswer(async () => {
			const deleteAsked = approvals.some((a) => a.name === "delete_chat_history");
			const changedAccount = approvals.some((a) => a.name === "update_my_profile" || a.name === "set_token_budget");
			await answer(approved);
			// The new name and limit live in server components (sidebar, Usage page): fetch them again.
			if (approved && changedAccount) router.refresh();
			// The tool only says "approved"; the thread is deleted now that the
			// reply has ended, so the agent was not still writing to it.
			if (approved && deleteAsked) setTimeout(removeChat, 1000);
		});
	}

	function submit() {
		const text = input.trim();
		if (!text || running || loading || paused) return;
		atBottom.current = true;
		void send(text, thinkingLevel);
		void touchChat(threadId, text);
		setInput("");
	}

	function chooseThinking(level: ThinkingLevel) {
		setThinkingLevel(level);
		try {
			localStorage.setItem(THINKING_KEY, level);
		} catch {
			// Blocked storage: the pick still applies until the page is reloaded.
		}
	}

	function confirmDelete() {
		if (!confirm("Delete this chat? This cannot be undone.")) return;
		startDelete(removeChat);
	}

	const composer = (
		<Composer
			value={input}
			onChange={setInput}
			onSubmit={submit}
			onStop={stop}
			thinkingLevel={thinkingLevel}
			onThinkingLevelChange={chooseThinking}
			running={running}
			disabled={loading || paused}
		/>
	);

	if (loading) return <p className="animate-pulse pt-16 text-center text-sm text-muted">Loading chat…</p>;

	if (messages.length === 0 && !running)
		return (
			<div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-8 px-4">
				<h2 className="text-center text-3xl font-semibold tracking-tight">What can I help with?</h2>
				<div className="w-full">{composer}</div>
				{error && <p className="text-sm text-danger">{error.message}</p>}
			</div>
		);

	const last = messages.at(-1);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-12 shrink-0 items-center justify-end gap-3 px-3 max-md:pl-14">
				{context && <ContextMeter context={context} />}
				<button
					type="button"
					onClick={confirmDelete}
					// A streaming reply would save itself back after the delete.
					disabled={deleting || running}
					className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-muted hover:bg-hover hover:text-foreground disabled:opacity-50">
					<TrashIcon />
					{deleting ? "Deleting…" : "Delete chat"}
				</button>
			</div>

			{/* Only the messages scroll. */}
			<div
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					atBottom.current = el.clientHeight + el.scrollTop >= el.scrollHeight - 120;
				}}
				className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pt-4 pb-8">
					{messages.map((message) =>
						message.role === "user" ? (
							<div
								key={message.id}
								className="max-w-[85%] self-end rounded-3xl bg-surface px-5 py-2.5 break-words whitespace-pre-wrap sm:max-w-[75%]">
								{message.parts.map((p) => (p.type === "text" ? p.text : null))}
							</div>
						) : (
							<AssistantMessage
								key={message.id}
								message={message}
								streaming={running && message === last}
								latest={message === last}
								waiting={approvals.map((a) => a.toolCallId)}
							/>
						),
					)}
					{thinking && <span className="size-3.5 animate-pulse rounded-full bg-foreground" />}

					{approvals.length > 0 && (
						<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-2xl bg-surface p-3 pl-4">
							<div className="flex min-w-0 flex-col gap-2 text-sm">
								{approvals.map((approval) => {
									// First line is the title; the rest are the details, e.g. "Name: Abdullah → Abdul".
									const [title, ...details] = (approval.description || "").split("\n");
									return (
										<div key={approval.id}>
											<p className="font-medium">{title || "The agent needs your approval to continue."}</p>
											{details.map((line) => (
												<p key={line} className="text-muted">
													{line}
												</p>
											))}
										</div>
									);
								})}
							</div>
							<div className="flex shrink-0 gap-2">
								<button
									type="button"
									onClick={() => decide(false)}
									disabled={answering}
									className="rounded-full bg-hover px-4 py-1.5 text-sm hover:opacity-80 disabled:opacity-50">
									Deny
								</button>
								<button
									type="button"
									onClick={() => decide(true)}
									disabled={answering}
									className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:opacity-85 disabled:opacity-50">
									Approve
								</button>
							</div>
						</div>
					)}

					{error && <p className="text-sm text-danger">{error.message}</p>}
				</div>
			</div>

			<div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-3">
				{composer}
				<p className="pt-2 text-center text-xs text-muted">The agent can make mistakes. Check important info.</p>
			</div>
		</div>
	);
}
