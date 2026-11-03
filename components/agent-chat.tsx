"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { deleteChat, touchChat } from "@/lib/actions";
import {
	THINKING_LEVELS,
	useAgentChat,
	type ChatMessage,
	type ContextUsage,
	type Part,
	type ThinkingLevel,
} from "@/lib/use-agent-chat";

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

// Markdown styles, applied to the rendered elements inside one wrapper.
const MARKDOWN =
	"[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-4 [&_strong]:font-semibold [&_a]:underline [&_a]:underline-offset-2 " +
	"[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold " +
	"[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold " +
	"[&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1.5 [&_li]:pl-1 [&_li::marker]:text-muted " +
	"[&_hr]:my-6 [&_hr]:border-line " +
	"[&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:text-muted " +
	"[&_code]:rounded-md [&_code]:bg-surface [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.875em] " +
	"[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-2xl [&_pre]:bg-code [&_pre]:p-4 [&_pre]:text-sm [&_pre]:leading-6 [&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
	"[&_table]:my-4 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-sm [&_th]:border-b [&_th]:border-line [&_th]:py-2 [&_th]:pr-4 [&_th]:text-left [&_th]:font-semibold " +
	"[&_td]:border-b [&_td]:border-line [&_td]:py-2 [&_td]:pr-4";

// The chat UI for the Python agent server. All the talking to the server
// (streaming, approvals, history, stop) is in useAgentChat.
export function AgentChat({ threadId }: { threadId: string }) {
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
			await answer(approved);
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
							<div className="min-w-0 text-sm">
								{approvals.map((approval) => (
									<p key={approval.id}>{approval.description || "The agent needs your approval to continue."}</p>
								))}
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

// Markdown with GitHub extras (tables, strikethrough); links open in a new tab.
function MarkdownText({ text }: { text: string }) {
	return (
		<Markdown
			remarkPlugins={[remarkGfm]}
			components={{
				a: ({ href, children }) => (
					<a href={href} target="_blank" rel="noreferrer">
						{children}
					</a>
				),
			}}>
			{text}
		</Markdown>
	);
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// How much of the model's context the chat has filled, like "12.4K / 200K (6%)".
function ContextMeter({ context: { used, limit } }: { context: ContextUsage }) {
	const percent = limit ? (used / limit) * 100 : null;
	return (
		<span
			title="How much of the model's memory for this chat is used. A new chat starts empty."
			className="flex items-center gap-2 text-xs text-muted">
			{percent !== null && (
				<span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface">
					<span
						style={{ width: `${Math.min(percent, 100)}%` }}
						className={`block h-full rounded-full ${percent >= 80 ? "bg-danger" : "bg-muted"}`}
					/>
				</span>
			)}
			{limit
				? `${compact.format(used)} / ${compact.format(limit)} (${percent! < 1 ? "<1" : Math.round(percent!)}%)`
				: `${compact.format(used)} tokens`}
		</span>
	);
}

function Composer({
	value,
	onChange,
	onSubmit,
	onStop,
	thinkingLevel,
	onThinkingLevelChange,
	running,
	disabled,
}: {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	onStop: () => void;
	thinkingLevel: ThinkingLevel;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	running: boolean;
	disabled: boolean;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	// Grow with the text, up to max-h, then scroll.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [value]);

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit();
			}}
			className="flex items-end gap-2 rounded-[28px] border border-line bg-composer p-2 shadow-[0_2px_12px_rgb(0_0_0/0.06)]">
			<textarea
				ref={ref}
				rows={1}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					// Enter sends, Shift+Enter adds a line.
					if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault();
						onSubmit();
					}
				}}
				placeholder={disabled && !running ? "Answer the question above first" : "Ask anything"}
				className="max-h-52 min-w-0 flex-1 resize-none bg-transparent px-3 py-2 outline-none placeholder:text-muted"
			/>
			<select
				aria-label="Thinking level"
				value={thinkingLevel}
				onChange={(e) => onThinkingLevelChange(e.target.value as ThinkingLevel)}
				className="h-9 shrink-0 cursor-pointer rounded-full bg-transparent px-2 text-sm text-muted outline-none hover:bg-hover hover:text-foreground">
				{THINKING_LEVELS.map((level) => (
					<option key={level} value={level}>
						Thinking: {level}
					</option>
				))}
			</select>
			{running ? (
				<button
					type="button"
					// Closes the request, which also stops the reply on the server.
					onClick={onStop}
					aria-label="Stop"
					className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
					<span className="size-3 rounded-[3px] bg-current" />
				</button>
			) : (
				<button
					type="submit"
					aria-label="Send"
					disabled={!value.trim() || disabled}
					className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-30">
					<ArrowUpIcon />
				</button>
			)}
		</form>
	);
}

function AssistantMessage({
	message,
	streaming,
	latest,
	waiting,
}: {
	message: ChatMessage;
	streaming: boolean;
	latest: boolean;
	waiting: string[];
}) {
	const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
	const lastPart = message.parts.at(-1);
	// The reply is not over while a tool waits, so its totals would be early.
	const paused = message.parts.some((p) => waiting.includes(p.id));
	return (
		<div className="group/reply flex flex-col gap-3 leading-7">
			{message.parts.map((part) => {
				if (part.type === "text")
					return (
						<div key={part.id} className={MARKDOWN}>
							<MarkdownText text={part.text} />
						</div>
					);
				if (part.type === "reasoning")
					return <Reasoning key={part.id} part={part} active={streaming && part === lastPart} />;
				return (
					<ToolCall
						key={part.id}
						part={part}
						waiting={waiting.includes(part.id)}
						running={streaming}
					/>
				);
			})}
			{!streaming && !paused && (text || message.usage) && (
				// Like ChatGPT: older replies show this row on hover. Touch screens,
				// which cannot hover, always show it.
				<div
					className={`flex min-h-8 items-center gap-2 transition-opacity focus-within:opacity-100 ${
						latest ? "" : "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/reply:opacity-100"
					}`}>
					{text && (
						<div className="-ml-2">
							<CopyButton text={text} />
						</div>
					)}
					{message.usage && (
						<span title="Tokens used for this reply" className="text-xs text-muted">
							{message.usage.input.toLocaleString()} input · {message.usage.output.toLocaleString()} output tokens
						</span>
					)}
				</div>
			)}
		</div>
	);
}

// Gemini's reasoning summary: streamed live, restored after a reload by history.py.
function Reasoning({ part, active }: { part: Extract<Part, { type: "reasoning" }>; active: boolean }) {
	return (
		<details className="group">
			<summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
				<span className={active ? "animate-pulse" : undefined}>{active ? "Thinking" : "Thought"}</span>
				<ChevronIcon />
			</summary>
			<div className={`mt-2 border-l-2 border-line pl-4 text-sm text-muted ${MARKDOWN}`}>
				<MarkdownText text={part.text} />
			</div>
		</details>
	);
}

function ToolCall({
	part,
	waiting,
	running,
}: {
	part: Extract<Part, { type: "tool" }>;
	waiting: boolean;
	running: boolean;
}) {
	// The approval card under the reply already says what is being asked.
	if (waiting) return null;

	// These tools get a sentence instead of their name and raw output.
	const plain = plainToolView(part, running);
	if (plain) {
		return (
			<details className="group">
				<summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
					<CloudIcon />
					<span className={plain.active ? "animate-pulse" : undefined}>{plain.label}</span>
					{plain.detail && <ChevronIcon />}
				</summary>
				{plain.detail && (
					<p className="mt-2 border-l-2 border-line pl-4 text-sm text-muted">{plain.detail}</p>
				)}
			</details>
		);
	}

	// The web tools get their own summary and a list of sources.
	const web = webToolView(part);
	if (web) {
		const pending = part.result === undefined;
		return (
			<details className="group">
				<summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
					<GlobeIcon />
					<span className={pending && running ? "animate-pulse" : undefined}>{web.label}</span>
					<ChevronIcon />
				</summary>
				{web.sources.length > 0 && (
					<ul className="mt-2 flex flex-col gap-1 border-l-2 border-line pl-4 text-sm">
						{web.sources.map((s) => (
							<li key={s.url} className="truncate">
								<a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">
									{s.title || s.url}
								</a>{" "}
								<span className="text-muted">{hostname(s.url)}</span>
							</li>
						))}
					</ul>
				)}
			</details>
		);
	}

	// No result: still running, or denied (a denial streams no result; a reload
	// shows the reason).
	const status = part.result !== undefined ? "Used" : running ? "Running" : "Not run:";
	const hasInput = part.args && part.args !== "{}";
	return (
		<details className="group">
			<summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
				<ToolIcon />
				<span className={status === "Running" ? "animate-pulse" : undefined}>
					{status} <span className="font-medium">{part.name}</span>
				</span>
				<ChevronIcon />
			</summary>
			<div className="mt-2 flex flex-col gap-2 rounded-xl bg-code p-3 font-mono text-xs break-words text-muted">
				<span className="whitespace-pre-wrap">input: {hasInput ? part.args : "none"}</span>
				{part.result !== undefined && <span className="whitespace-pre-wrap">output: {part.result}</span>}
			</div>
		</details>
	);
}

// A sentence for the tools below (agent-server/tools.py). null for any other tool.
// A denied call streams no result; a reload shows the reason.
function plainToolView(
	part: Extract<Part, { type: "tool" }>,
	running: boolean,
): { label: string; detail?: string; active?: boolean } | null {
	if (part.name === "get_weather") {
		const { city } = parseJson<{ city?: string | null }>(part.args) ?? {};
		const where = city ? ` in ${city}` : "";
		if (part.result === undefined)
			return running ? { label: `Checking the weather${where}`, active: true } : { label: "Weather not checked" };
		return { label: `Checked the weather${where}`, detail: part.result };
	}
	return null;
}

type Source = { url: string; title?: string };

// What web_search and read_webpage (agent-server/tools.py) return, as a label
// and a list of sources. null for any other tool.
function webToolView(part: Extract<Part, { type: "tool" }>): { label: string; sources: Source[] } | null {
	if (part.name !== "web_search" && part.name !== "read_webpage") return null;
	const args = parseJson<{ query?: string; urls?: string[] }>(part.args) ?? {};
	const result = parseJson<{ results?: Source[]; pages?: Source[]; error?: string }>(part.result);
	if (part.name === "web_search") {
		const query = args.query ? `“${args.query}”` : "the web";
		if (!result) return { label: `Searching ${query}`, sources: [] };
		if (result.error) return { label: `Search failed: ${result.error}`, sources: [] };
		return { label: `Searched ${query} · ${result.results?.length ?? 0} results`, sources: result.results ?? [] };
	}
	const count = args.urls?.length ?? 0;
	if (!result) return { label: `Reading ${count === 1 ? "a page" : `${count} pages`}`, sources: [] };
	if (result.error) return { label: `Reading failed: ${result.error}`, sources: [] };
	const pages = result.pages ?? [];
	return { label: `Read ${pages.length === 1 ? "1 page" : `${pages.length} pages`}`, sources: pages };
}

function parseJson<T>(text: string | undefined): T | null {
	if (!text) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

function hostname(url: string) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			aria-label="Copy"
			onClick={async () => {
				await navigator.clipboard.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
			className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-foreground">
			{copied ? <CheckIcon /> : <CopyIcon />}
		</button>
	);
}

const icon = {
	width: 16,
	height: 16,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 2,
	strokeLinecap: "round",
	strokeLinejoin: "round",
	"aria-hidden": true,
} as const;

function ArrowUpIcon() {
	return (
		<svg {...icon} width={18} height={18}>
			<path d="M12 19V5M5 12l7-7 7 7" />
		</svg>
	);
}

function ChevronIcon() {
	return (
		<svg {...icon} width={14} height={14} className="transition-transform group-open:rotate-90">
			<path d="m9 6 6 6-6 6" />
		</svg>
	);
}

function GlobeIcon() {
	return (
		<svg {...icon} width={14} height={14}>
			<circle cx="12" cy="12" r="9" />
			<path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
		</svg>
	);
}

function CloudIcon() {
	return (
		<svg {...icon} width={14} height={14}>
			<path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 11a3.5 3.5 0 0 1-.5 7z" />
		</svg>
	);
}

function ToolIcon() {
	return (
		<svg {...icon} width={14} height={14}>
			<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />
		</svg>
	);
}

function CopyIcon() {
	return (
		<svg {...icon}>
			<rect x="9" y="9" width="12" height="12" rx="2" />
			<path d="M5 15V5a2 2 0 0 1 2-2h10" />
		</svg>
	);
}

function CheckIcon() {
	return (
		<svg {...icon}>
			<path d="M20 6 9 17l-5-5" />
		</svg>
	);
}

function TrashIcon() {
	return (
		<svg {...icon} width={14} height={14}>
			<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
		</svg>
	);
}
