"use client";

// The model's reasoning, shown above its answer. Gemini sends a short summary of
// its thinking, not every step. Open while the model is still thinking; once the
// answer starts it folds away, and a click opens it again.
export function Thinking({ content, done }: { content: string; done: boolean }) {
	return (
		<details
			open={!done}
			className="group mb-2 rounded-md border border-dashed border-zinc-300 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
		>
			<summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1 font-medium">
				<span className="transition group-open:rotate-90">›</span>
				{done ? "Thought process" : <span className="animate-pulse">Thinking…</span>}
			</summary>
			<p className="border-t border-dashed border-zinc-300 px-2 py-1.5 whitespace-pre-wrap italic dark:border-zinc-700">
				{content}
			</p>
		</details>
	);
}
