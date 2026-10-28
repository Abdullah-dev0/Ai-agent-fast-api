"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2";

// Our own chat UI on top of CopilotKit's headless hooks. CopilotKit still does
// the work (talking to the runtime, rejoining a running reply after a refresh);
// this file only decides how it looks.

const TOOLS: Record<string, { icon: string; label: string }> = {
	get_current_time: { icon: "🕐", label: "Checking the time" },
	get_weather: { icon: "☀️", label: "Checking the weather" },
	calculate: { icon: "🧮", label: "Calculating" },
};

const SUGGESTIONS = [
	"What's the weather in Lahore?",
	"What time is it in Tokyo?",
	"What is 15% of 2400?",
	"Compare the weather in London and Karachi",
];

type ToolCall = { id: string; function: { name: string; arguments: string } };
type ChatMessage = {
	id: string;
	role: string;
	content?: unknown;
	toolCalls?: ToolCall[];
	toolCallId?: string;
};

/** The message's text, whether content is a string or a list of parts. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((p) => (p?.type === "text" ? p.text : "")).join("");
	return "";
}

/** Minimal markdown: **bold** and "- " / "* " bullets, which is what Gemini mostly sends. */
function Formatted({ text }: { text: string }) {
	return (
		<>
			{text.split("\n").map((line, i) => {
				const bullet = /^\s*[-*]\s+/.test(line);
				const parts = line.replace(/^\s*[-*]\s+/, "").split(/(\*\*[^*]+\*\*)/g);
				const body = parts.map((part, j) =>
					part.startsWith("**") && part.endsWith("**") ? (
						<strong key={j} className="font-semibold">
							{part.slice(2, -2)}
						</strong>
					) : (
						part
					),
				);
				if (bullet)
					return (
						<div key={i} className="flex gap-2 pl-1">
							<span className="text-violet-500">•</span>
							<span>{body}</span>
						</div>
					);
				return line.trim() ? <p key={i}>{body}</p> : <div key={i} className="h-2" />;
			})}
		</>
	);
}

function ToolChip({ call, result }: { call: ToolCall; result?: string }) {
	const tool = TOOLS[call.function.name] ?? { icon: "🔧", label: call.function.name };
	return (
		<details className="group w-fit max-w-full rounded-xl border border-violet-200/70 bg-violet-50/70 text-xs text-violet-900 dark:border-violet-500/20 dark:bg-violet-500/10 dark:text-violet-200">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5">
				<span>{tool.icon}</span>
				<span className="font-medium">{result === undefined ? `${tool.label}…` : tool.label.replace(/ing\b/, "ed")}</span>
				{result === undefined ? (
					<span className="size-3 animate-spin rounded-full border-2 border-violet-300 border-t-violet-600" />
				) : (
					<span className="text-violet-400 transition group-open:rotate-90">›</span>
				)}
			</summary>
			<div className="space-y-1 border-t border-violet-200/70 px-3 py-2 font-mono text-[11px] dark:border-violet-500/20">
				<p>
					<span className="text-violet-500">input </span>
					{call.function.arguments}
				</p>
				{result !== undefined && (
					<p>
						<span className="text-violet-500">result </span>
						{result}
					</p>
				)}
			</div>
		</details>
	);
}

function Avatar() {
	return (
		<div className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-sm text-white shadow-sm shadow-violet-500/30">
			✦
		</div>
	);
}

export function AgentChat({ threadId }: { threadId: string }) {
	// A private agent pinned to this user's thread: `agentId` is a local name,
	// `runtimeAgentId` is the "assistant" agent defined in app/api/copilotkit.
	const { agent } = useAgent({ agentId: `assistant:${threadId}`, threadId, runtimeAgentId: "assistant" });
	const { copilotkit } = useCopilotKit();
	const router = useRouter();
	const [input, setInput] = useState("");
	const bottomRef = useRef<HTMLDivElement>(null);

	// Connecting replays the saved chat and rejoins a reply that is still being
	// written, which is how a refresh mid-reply keeps going.
	useEffect(() => {
		copilotkit.connectAgent({ agent }).catch((error) => console.error("connectAgent failed", error));
	}, [agent, copilotkit]);

	const messages = agent.messages as ChatMessage[];
	const running = agent.isRunning;
	const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, textOf(m.content)]));
	const last = messages.at(-1);
	// Dots until the reply's first words (or first tool) show up.
	const waiting = running && !(last?.role === "assistant" && (textOf(last.content) || last.toolCalls?.length));

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
	}, [messages.length, last?.content, running]);

	function send(text: string) {
		const trimmed = text.trim();
		if (!trimmed || running) return;
		agent.addMessage({ id: crypto.randomUUID(), role: "user", content: trimmed });
		copilotkit.runAgent({ agent }).catch((error) => console.error("runAgent failed", error));
		setInput("");
	}

	return (
		<div className="flex h-[75vh] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl shadow-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-950">
			<header className="flex items-center gap-3 border-b border-zinc-100 bg-gradient-to-r from-violet-50 via-white to-fuchsia-50 px-5 py-4 dark:border-zinc-800 dark:from-violet-950/40 dark:via-zinc-950 dark:to-fuchsia-950/40">
				<Avatar />
				<div className="flex-1">
					<p className="font-semibold">Assistant</p>
					<p className="flex items-center gap-1.5 text-xs text-zinc-500">
						<span className={`size-1.5 rounded-full ${running ? "animate-pulse bg-amber-500" : "bg-emerald-500"}`} />
						{running ? "Thinking…" : "Online · Gemini"}
					</p>
				</div>
				<div className="hidden gap-1.5 sm:flex">
					{Object.values(TOOLS).map((t) => (
						<span key={t.icon} className="rounded-full bg-white/80 px-2 py-0.5 text-xs shadow-sm dark:bg-zinc-900">
							{t.icon}
						</span>
					))}
				</div>
				<button
					type="button"
					// A new thread means a fresh conversation: no old messages or rules.
					onClick={() => router.push(`/agent?thread=${crypto.randomUUID()}`)}
					disabled={running}
					className="rounded-full border border-violet-200 bg-white px-3 py-1 text-xs font-medium text-violet-700 shadow-sm transition hover:bg-violet-50 disabled:opacity-50 dark:border-violet-500/30 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-500/10"
				>
					+ New chat
				</button>
			</header>

			<div className="flex-1 space-y-5 overflow-y-auto px-5 py-6">
				{messages.length === 0 && !running && (
					<div className="flex h-full flex-col items-center justify-center gap-5 text-center">
						<div className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-2xl text-white shadow-lg shadow-violet-500/30">
							✦
						</div>
						<div>
							<p className="text-lg font-semibold">How can I help?</p>
							<p className="text-sm text-zinc-500">I can check the time, the weather, and do math.</p>
						</div>
						<div className="flex max-w-md flex-wrap justify-center gap-2">
							{SUGGESTIONS.map((s) => (
								<button
									key={s}
									onClick={() => send(s)}
									className="rounded-full border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 transition hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-violet-500/40 dark:hover:bg-violet-500/10"
								>
									{s}
								</button>
							))}
						</div>
					</div>
				)}

				{messages.map((message) => {
					if (message.role === "user")
						return (
							<div key={message.id} className="flex justify-end">
								<div className="max-w-[80%] rounded-2xl rounded-br-md bg-gradient-to-br from-violet-600 to-fuchsia-600 px-4 py-2.5 text-sm text-white shadow-md shadow-violet-600/20">
									{textOf(message.content)}
								</div>
							</div>
						);
					if (message.role !== "assistant") return null;
					const text = textOf(message.content);
					if (!text && !message.toolCalls?.length) return null;
					return (
						<div key={message.id} className="flex gap-3">
							<Avatar />
							<div className="min-w-0 max-w-[85%] space-y-2">
								{message.toolCalls?.map((call) => (
									<ToolChip key={call.id} call={call} result={results.get(call.id)} />
								))}
								{text && (
									<div className="space-y-1 rounded-2xl rounded-tl-md bg-zinc-100 px-4 py-2.5 text-sm leading-relaxed text-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
										<Formatted text={text} />
									</div>
								)}
							</div>
						</div>
					);
				})}

				{waiting && (
					<div className="flex gap-3">
						<Avatar />
						<div className="flex items-center gap-1 rounded-2xl rounded-tl-md bg-zinc-100 px-4 py-3 dark:bg-zinc-900">
							{[0, 150, 300].map((delay) => (
								<span
									key={delay}
									className="size-1.5 animate-bounce rounded-full bg-violet-500"
									style={{ animationDelay: `${delay}ms` }}
								/>
							))}
						</div>
					</div>
				)}
				<div ref={bottomRef} />
			</div>

			<form
				onSubmit={(e) => {
					e.preventDefault();
					send(input);
				}}
				className="border-t border-zinc-100 p-4 dark:border-zinc-800"
			>
				<div className="flex items-end gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-2 transition focus-within:border-violet-400 focus-within:ring-4 focus-within:ring-violet-500/10 dark:border-zinc-800 dark:bg-zinc-900">
					<textarea
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							// Enter sends, Shift+Enter adds a new line.
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send(input);
							}
						}}
						rows={1}
						placeholder="Ask about the time, the weather, or some math…"
						className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-zinc-400"
					/>
					{running ? (
						<button
							type="button"
							onClick={() => copilotkit.stopAgent({ agent })}
							className="rounded-xl bg-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-200"
						>
							Stop
						</button>
					) : (
						<button
							type="submit"
							disabled={!input.trim()}
							aria-label="Send"
							className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white shadow-md shadow-violet-600/30 transition hover:opacity-90 disabled:opacity-40 disabled:shadow-none"
						>
							↑
						</button>
					)}
				</div>
			</form>
		</div>
	);
}
