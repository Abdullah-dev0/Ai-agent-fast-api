"use client";

import { memo, useState } from "react";
import type { ChatMessage, ToolStep } from "@/lib/chat-types";
import { CheckIcon, CopyIcon } from "./icons";
import { MARKDOWN, MarkdownText } from "./markdown";
import { ToolCall } from "./tool-call";

type Props = {
	messages: ChatMessage[];
	streaming: boolean;
	latest: boolean;
	waiting: string[];
	// How long the model thought for this reply, and whether it is thinking now.
	seconds?: number;
	reasoning: boolean;
};

// One reply: the assistant messages useChat made for it (a new one per tool round).
// Memoized on those messages, so older replies skip re-rendering (and re-parsing
// their markdown) while a newer one streams.
export const AssistantMessage = memo(function AssistantMessage({
	messages,
	streaming,
	latest,
	waiting,
	seconds,
	reasoning,
}: Props) {
	const parts = messages.flatMap((m) => m.parts);
	// A tool's result is its own part, often in a later message than its call.
	const results = new Map(parts.flatMap((p) => (p.type === "tool-result" ? [[p.toolCallId, p] as const] : [])));
	const text = parts.flatMap((p) => (p.type === "text" ? [p.content] : [])).join("\n\n");
	// The reply is not over while a tool waits for the user's OK.
	const paused = parts.some((p) => p.type === "tool-call" && waiting.includes(p.id));
	return (
		<div className="group/reply flex flex-col gap-3 leading-7">
			{/* Like ChatGPT: that the model thought and for how long, never what. */}
			{(reasoning || !!seconds) && (
				<p className={`text-sm text-muted ${reasoning ? "animate-pulse" : ""}`}>
					{reasoning ? "Thinking…" : `Thought for ${seconds}s`}
				</p>
			)}
			{parts.map((part, i) => {
				if (part.type === "text" && part.content)
					return (
						<div key={i} className={MARKDOWN}>
							<MarkdownText text={part.content} />
						</div>
					);
				// The approval card under the reply already says what a waiting call asks.
				if (part.type === "tool-call" && !waiting.includes(part.id)) {
					const result = results.get(part.id);
					const step: ToolStep = {
						id: part.id,
						name: part.name,
						args: part.arguments,
						result: typeof result?.content === "string" ? result.content : undefined,
						failed: result?.state === "error",
					};
					return <ToolCall key={part.id} part={step} running={streaming} />;
				}
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
}, sameReply);

function sameReply(a: Props, b: Props) {
	return (
		a.streaming === b.streaming &&
		a.latest === b.latest &&
		a.waiting === b.waiting &&
		a.seconds === b.seconds &&
		a.reasoning === b.reasoning &&
		a.messages.length === b.messages.length &&
		a.messages.every((m, i) => m === b.messages[i])
	);
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
