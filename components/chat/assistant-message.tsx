"use client";

import { useState } from "react";
import type { ChatMessage, Part } from "@/lib/chat-types";
import { CheckIcon, ChevronIcon, CopyIcon } from "./icons";
import { MARKDOWN, MarkdownText } from "./markdown";
import { ToolCall } from "./tool-call";

export function AssistantMessage({
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
