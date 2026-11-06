"use client";

import { memo, useState } from "react";
import type { ChatMessage } from "@/lib/chat-types";
import { CheckIcon, CopyIcon } from "./icons";
import { MARKDOWN, MarkdownText } from "./markdown";
import { ToolCall } from "./tool-call";

// Memoized: the chat re-renders on every streamed token, but only the reply being
// written gets a new `message` (use-agent-chat keeps the others as the same
// objects), so older replies skip re-rendering and re-parsing their markdown.
export const AssistantMessage = memo(function AssistantMessage({
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
	// The reply is not over while a tool waits, so its totals would be early.
	const paused = message.parts.some((p) => waiting.includes(p.id));
	// Like ChatGPT: one line for all the reply's reasoning, never its text (that stays
	// on the server). Timed live only, so a reloaded chat shows no line.
	const last = message.parts.at(-1);
	const thinking = streaming && last?.type === "reasoning" && last.seconds === undefined;
	const seconds = message.parts.reduce((sum, p) => sum + (p.type === "reasoning" ? (p.seconds ?? 0) : 0), 0);
	return (
		<div className="group/reply flex flex-col gap-3 leading-7">
			{(thinking || seconds > 0) && (
				<p className={`text-sm text-muted ${thinking ? "animate-pulse" : ""}`}>
					{thinking ? "Thinking…" : `Thought for ${seconds}s`}
				</p>
			)}
			{message.parts.map((part) => {
				if (part.type === "text")
					return (
						<div key={part.id} className={MARKDOWN}>
							<MarkdownText text={part.text} />
						</div>
					);
				// The approval card under the reply already says what a waiting call asks.
				if (part.type === "tool" && !waiting.includes(part.id))
					return <ToolCall key={part.id} part={part} running={streaming} />;
				return null;
			})}
			{!streaming && !paused && text && (
				// Like ChatGPT: older replies show this row on hover. Touch screens,
				// which cannot hover, always show it.
				<div
					className={`flex min-h-8 items-center gap-2 transition-opacity focus-within:opacity-100 ${
						latest ? "" : "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/reply:opacity-100"
					}`}>
					<div className="-ml-2">
						<CopyButton text={text} />
					</div>
				</div>
			)}
		</div>
	);
});

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
