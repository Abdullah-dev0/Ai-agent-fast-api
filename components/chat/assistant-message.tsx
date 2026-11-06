"use client";

import { memo, useState } from "react";
import type { ChatMessage } from "@/lib/chat-types";
import { CheckIcon, CopyIcon } from "./icons";
import { MARKDOWN, MarkdownText } from "./markdown";
import { ToolCall } from "./tool-call";

// How long the model thought, from the server (ui_stream.py sends it on reasoning-end).
function secondsOf(part: ChatMessage["parts"][number]): number {
	if (part.type !== "reasoning") return 0;
	const seconds = part.providerMetadata?.aragon?.seconds;
	return typeof seconds === "number" ? seconds : 0;
}

// Memoized: the chat re-renders on every streamed token, but only the reply being
// written gets a new `message` (useChat keeps the others as the same objects), so
// older replies skip re-rendering and re-parsing their markdown.
export const AssistantMessage = memo(function AssistantMessage({
	message,
	streaming,
	latest,
}: {
	message: ChatMessage;
	streaming: boolean;
	latest: boolean;
}) {
	const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
	// A tool still waits for the user's OK: the reply is not over.
	const paused = message.parts.some(
		(p) => p.type === "dynamic-tool" && (p.state === "approval-requested" || p.state === "approval-responded"),
	);
	// Like ChatGPT: one line for all the reply's reasoning, never its text (that stays
	// on the server). Timed live only, so a reloaded chat shows no line.
	const last = message.parts.at(-1);
	const thinking = streaming && last?.type === "reasoning" && last.state === "streaming";
	const seconds = message.parts.reduce((sum, p) => sum + secondsOf(p), 0);
	return (
		<div className="group/reply flex flex-col gap-3 leading-7">
			{(thinking || seconds > 0) && (
				<p className={`text-sm text-muted ${thinking ? "animate-pulse" : ""}`}>
					{thinking ? "Thinking…" : `Thought for ${seconds}s`}
				</p>
			)}
			{message.parts.map((part, i) => {
				if (part.type === "text")
					return (
						<div key={i} className={MARKDOWN}>
							<MarkdownText text={part.text} />
						</div>
					);
				// The approval card under the reply already says what a waiting call asks.
				if (part.type === "dynamic-tool" && part.state !== "approval-requested" && part.state !== "approval-responded")
					return <ToolCall key={part.toolCallId} part={part} running={streaming} />;
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
