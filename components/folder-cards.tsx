"use client";

import { useEffect, useRef, useState } from "react";
import { canOpenFolders, confirmWrite, pickFolder, reviewWrite, type BrowserToolResult } from "@/lib/browser-tools";
import { collapseDiff, type DiffLine } from "@/lib/folder";

const BUTTON =
	"rounded-full bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const QUIET_BUTTON =
	"rounded-full px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-200 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800";

type Done = (result: BrowserToolResult) => void;

// open_folder's card. Browsers only open the folder picker from a real click.
export function FolderPicker({ threadId, onDone }: { threadId: string; onDone: Done }) {
	const [busy, setBusy] = useState(false);
	// Safe at render: this card only appears after the chat has loaded in the browser.
	const supported = canOpenFolders();

	return (
		<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl bg-zinc-100 py-2.5 pr-2.5 pl-4 dark:bg-zinc-900">
			<div className="min-w-0 text-sm">
				<p>Choose a folder for the agent</p>
				<p className="text-xs text-zinc-500">
					{supported
						? "It sees file names. It asks before reading a file, and shows you every change."
						: "This browser cannot open folders. Use Chrome or Edge."}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<button
					type="button"
					disabled={busy}
					onClick={() => onDone({ error: "The user did not choose a folder." })}
					className={QUIET_BUTTON}>
					Cancel
				</button>
				{supported && (
					<button
						type="button"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							const result = await pickFolder(threadId);
							setBusy(false);
							if (result) onDone(result);
						}}
						className={BUTTON}>
						{busy ? "Waiting…" : "Choose folder"}
					</button>
				)}
			</div>
		</div>
	);
}

const LINE_STYLE = {
	same: "text-zinc-500",
	add: "bg-green-500/15 text-green-700 dark:text-green-400",
	remove: "bg-red-500/15 text-red-700 dark:text-red-400",
};
const LINE_MARK = { same: " ", add: "+", remove: "-" };

// write_file's card. The only way to write a file: the agent asks, the user reads the
// change here, and Apply is what writes it. A write that would be refused answers
// straight away, so the model can read the file again.
export function WriteReview({
	threadId,
	args,
	onDone,
}: {
	threadId: string;
	args: Record<string, unknown>;
	onDone: Done;
}) {
	const path = String(args.path);
	const content = String(args.content);
	const [review, setReview] = useState<{ path: string; isNew: boolean; diff: DiffLine[] } | null>(null);
	const [applying, setApplying] = useState(false);
	const card = useRef<HTMLDivElement>(null);

	// The diff loads after the chat has scrolled, and the buttons must be on screen.
	useEffect(() => {
		if (review) card.current?.scrollIntoView({ block: "nearest" });
	}, [review]);

	useEffect(() => {
		reviewWrite(threadId, path, content)
			.then(setReview)
			.catch((e: unknown) => onDone({ error: e instanceof Error ? e.message : String(e) }));
		// Once per card: onDone changes with every render, and the answer cannot change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [threadId, path, content]);

	if (!review) return <p className="animate-pulse text-sm text-zinc-500">Preparing the change…</p>;

	const added = review.diff.filter((l) => l.type === "add").length;
	const removed = review.diff.filter((l) => l.type === "remove").length;
	return (
		<div ref={card} className="flex flex-col gap-2 rounded-2xl bg-zinc-100 p-2.5 dark:bg-zinc-900">
			<p className="flex flex-wrap items-baseline gap-x-2 px-1.5 text-sm">
				<span>{review.isNew ? "Create" : "Change"}</span>
				<span className="font-mono text-xs break-all">{review.path}</span>
				<span className="text-xs text-zinc-500">
					+{added} −{removed}
				</span>
			</p>
			{added + removed === 0 ? (
				<p className="px-1.5 text-xs text-zinc-500">No changes.</p>
			) : (
				<div className="max-h-80 overflow-auto rounded-xl bg-white py-2 font-mono text-xs leading-5 dark:bg-zinc-950">
					{collapseDiff(review.diff).map((line, at) =>
						line.type === "skip" ? (
							<p key={at} className="px-3 py-0.5 text-zinc-400 italic">
								{line.count} unchanged {line.count === 1 ? "line" : "lines"}
							</p>
						) : (
							<p key={at} className={`min-w-fit px-3 whitespace-pre ${LINE_STYLE[line.type]}`}>
								<span className="inline-block w-4 select-none">{LINE_MARK[line.type]}</span>
								{line.text}
							</p>
						),
					)}
				</div>
			)}
			<div className="flex justify-end gap-1.5">
				<button
					type="button"
					disabled={applying}
					onClick={() => onDone({ error: "The user rejected this change. The file was not changed." })}
					className={QUIET_BUTTON}>
					Reject
				</button>
				<button
					type="button"
					disabled={applying}
					onClick={async () => {
						setApplying(true);
						onDone(await confirmWrite(threadId, path, content));
					}}
					className={BUTTON}>
					{applying ? "Saving…" : "Apply"}
				</button>
			</div>
		</div>
	);
}
