"use client";

import { useEffect, useRef } from "react";
import { THINKING_LEVELS, type ThinkingLevel } from "@/lib/chat-types";
import { ArrowUpIcon } from "./icons";

export function Composer({
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
