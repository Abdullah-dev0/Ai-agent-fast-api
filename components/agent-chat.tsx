"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DELETE_CHAT_TOOL } from "@/lib/agent-tools";
import { deleteChat, touchChat } from "@/lib/actions";
import { THINKING_LEVELS, type ChatMessage, type ThinkingLevel } from "@/lib/chat-types";
import { useAgentChat } from "@/lib/use-agent-chat";
import { AssistantMessage } from "./chat/assistant-message";
import { Composer } from "./chat/composer";
import { ContextMeter } from "./chat/context-meter";
import { TrashIcon } from "./chat/icons";

// Each user message, and each reply: useChat starts a new assistant message after
// every tool round, so a reply is the assistant messages in a row.
function toTurns(messages: readonly ChatMessage[]): ChatMessage[][] {
	const turns: ChatMessage[][] = [];
	for (const m of messages) {
		const prev = turns.at(-1);
		if (m.role === "assistant" && prev?.[0].role === "assistant") prev.push(m);
		else turns.push([m]);
	}
	return turns;
}

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
	const [deleteError, setDeleteError] = useState<string>();
	// The user's pick per waiting approval (by id), until all have one and it is sent.
	const [decisions, setDecisions] = useState<ReadonlyMap<string, boolean>>(new Map());
	const {
		messages,
		approvals,
		context,
		loading,
		running,
		thinking,
		thoughts,
		reasoningFor,
		error: replyError,
		send,
		answer,
		stop,
	} = useAgentChat({
		url: AGENT_URL,
		threadId,
	});
	// The run is paused until the user answers: a new message would not fit.
	const paused = approvals.length > 0;
	// The tool calls waiting for an answer. Memoized: a new array on every render
	// would make every AssistantMessage (a memo) re-render on every streamed token.
	const waiting = useMemo(() => approvals.map((a) => a.toolCallId), [approvals]);

	// Follow the reply as it streams, but only while the user is at the bottom:
	// scrolling up to read stops the following.
	const atBottom = useRef(true);
	const scroller = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = scroller.current;
		if (el && atBottom.current) el.scrollTo({ top: el.scrollHeight });
	}, [messages, thinking, approvals, loading]);

	const error = deleteError ?? replyError?.message;

	// The thread first (DELETE /agent in main.py): if that fails, the chat stays in
	// the list. Then deleteChat removes the chat's row and leaves the page.
	async function removeChat() {
		const res = await fetch(`${AGENT_URL}?threadId=${encodeURIComponent(threadId)}`, { method: "DELETE" });
		if (!res.ok) return setDeleteError(`Could not delete the chat (${res.status})`);
		await deleteChat(threadId);
	}

	// Each approval gets its own answer. The run resumes once every one has one.
	// Not in a transition: React would hold back the hook's state updates (the cards
	// clearing, `running`) until the whole reply and the refresh were done.
	async function decide(id: string, approved: boolean) {
		const next = new Map(decisions).set(id, approved);
		if (!approvals.every((a) => next.has(a.id))) {
			setDecisions(next);
			return;
		}
		setDecisions(new Map());
		const deleteApproved = approvals.some((a) => a.name === DELETE_CHAT_TOOL && next.get(a.id));
		// Resolves when the server has closed the stream, so the agent is done writing.
		const completed = await answer(next);
		// The tool deleted the chat on the server: leave it and update the list.
		if (deleteApproved && completed) return deleteChat(threadId);
		// An approved tool may have changed the name or limit shown by server
		// components (sidebar, Usage page): fetch them again.
		if ([...next.values()].some(Boolean)) router.refresh();
	}

	// Takes back an answer before the rest are in.
	function undecide(id: string) {
		const next = new Map(decisions);
		next.delete(id);
		setDecisions(next);
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
				{error && <p className="text-sm text-danger">{error}</p>}
			</div>
		);

	const turns = toTurns(messages);
	const last = turns.at(-1);
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
					{turns.map((turn, i) =>
						turn[0].role === "user" ? (
							<div
								key={turn[0].id}
								className="max-w-[85%] self-end rounded-3xl bg-surface px-5 py-2.5 break-words whitespace-pre-wrap sm:max-w-[75%]">
								{turn[0].parts.map((p) => (p.type === "text" ? p.content : null))}
							</div>
						) : (
							<AssistantMessage
								key={turn[0].id}
								messages={turn}
								streaming={running && turn === last}
								latest={turn === last}
								waiting={waiting}
								// Keyed by the user message the reply answers (useAgentChat).
								seconds={thoughts.get(turns[i - 1]?.[0].id ?? "")}
								reasoning={!!reasoningFor && reasoningFor === turns[i - 1]?.[0].id}
							/>
						),
					)}
					{/* Before the reply has anything to show: "Thinking…" if the model reasons. */}
					{thinking &&
						(reasoningFor ? (
							<p className="animate-pulse text-sm text-muted">Thinking…</p>
						) : (
							<span className="size-3.5 animate-pulse rounded-full bg-foreground" />
						))}

					{approvals.length > 0 && (
						<div className="flex flex-col gap-4 rounded-2xl bg-surface p-3 pl-4">
							{approvals.map(({ id, card }) => (
								<div key={id} className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-3">
									<div className="flex min-w-0 flex-col gap-0.5 text-sm">
										<p className="font-medium">{card.title || "The agent needs your approval to continue."}</p>
										{/* Detail lines, e.g. "Name: Abdullah → Abdul". */}
										{card.details.map((line) => (
											<p key={line} className="text-muted">
												{line}
											</p>
										))}
									</div>
									{decisions.has(id) ? (
										// Answered, but the run waits for the rest: say so, and allow a change.
										<div className="flex shrink-0 items-center gap-2 text-sm">
											<span className="text-muted">{decisions.get(id) ? "Approved" : "Denied"}</span>
											<button
												type="button"
												onClick={() => undecide(id)}
												disabled={running}
												className="rounded-full px-3 py-1.5 text-muted hover:bg-hover hover:text-foreground disabled:opacity-50">
												Change
											</button>
										</div>
									) : (
										<div className="flex shrink-0 gap-2">
											<button
												type="button"
												onClick={() => void decide(id, false)}
												disabled={running}
												className="rounded-full bg-hover px-4 py-1.5 text-sm hover:opacity-80 disabled:opacity-50">
												Deny
											</button>
											<button
												type="button"
												onClick={() => void decide(id, true)}
												disabled={running}
												className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:opacity-85 disabled:opacity-50">
												Approve
											</button>
										</div>
									)}
								</div>
							))}
							{approvals.length > 1 && (
								<p className="text-xs text-muted">
									{decisions.size === 0
										? "Answer each one. The agent continues once all are answered."
										: `${approvals.length - decisions.size} more to answer, then the agent continues.`}
								</p>
							)}
						</div>
					)}

					{error && <p className="text-sm text-danger">{error}</p>}
				</div>
			</div>

			<div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-3">
				{composer}
				<p className="pt-2 text-center text-xs text-muted">The agent can make mistakes. Check important info.</p>
			</div>
		</div>
	);
}
