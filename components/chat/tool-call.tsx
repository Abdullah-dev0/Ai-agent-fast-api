import type { ReactNode } from "react";
import { ACCOUNT_SETTINGS, DELETE_CHAT_TOOL, parseAccountResult } from "@/lib/agent-tools";
import type { Part } from "@/lib/chat-types";
import { ChevronIcon, CloudIcon, GlobeIcon, ToolIcon, TrashIcon } from "./icons";

type ToolPart = Extract<Part, { type: "tool" }>;

// How one tool call looks: an icon and a line that opens to show `body`.
// No `body` means there is nothing to open.
type View = { icon: ReactNode; label: ReactNode; pulse?: boolean; body?: ReactNode };

// No result and not running: the tool did not run (stopped, or still to be
// answered). A failed result (denied, or the tool broke) is text for the model,
// so it is never shown: the line just says the step did not happen.
export function ToolCall({ part, waiting, running }: { part: ToolPart; waiting: boolean; running: boolean }) {
	// The approval card under the reply already says what is being asked.
	if (waiting) return null;

	// Tools we know get a sentence; any other tool gets its name.
	const view =
		weatherView(part, running) ??
		timeView(part, running) ??
		calculateView(part, running) ??
		accountView(part, running) ??
		deleteView(part, running) ??
		searchView(part, running) ??
		readPageView(part, running) ??
		otherView(part, running);

	return (
		<details className="group">
			<summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
				{view.icon}
				<span className={view.pulse ? "animate-pulse" : undefined}>{view.label}</span>
				{view.body && <ChevronIcon />}
			</summary>
			{view.body}
		</details>
	);
}

function note(text: string) {
	return <p className="mt-2 border-l-2 border-line pl-4 text-sm text-muted">{text}</p>;
}

// The three sentences of a step: while it runs, once it is done, and when it did
// not happen (no result, or a failed one). `body` opens only under `done`.
function stepView(
	part: ToolPart,
	running: boolean,
	icon: ReactNode,
	words: { running: string; done: string; notDone: string },
	body?: ReactNode,
): View {
	if (part.result === undefined)
		return running ? { icon, label: words.running, pulse: true } : { icon, label: words.notDone };
	if (part.failed) return { icon, label: words.notDone };
	return { icon, label: words.done, body };
}

// --- Tools from agent-server/tools.py and account_tools.py ---

function weatherView(part: ToolPart, running: boolean): View | null {
	if (part.name !== "get_weather") return null;
	const { city } = parseJson<{ city?: string | null }>(part.args) ?? {};
	const where = city ? ` in ${city}` : "";
	return stepView(
		part,
		running,
		<CloudIcon />,
		{ running: `Checking the weather${where}`, done: `Checked the weather${where}`, notDone: "Weather not checked" },
		part.result && note(part.result),
	);
}

function timeView(part: ToolPart, running: boolean): View | null {
	if (part.name !== "get_current_time") return null;
	const { timezone } = parseJson<{ timezone?: string }>(part.args) ?? {};
	const where = timezone ? ` in ${timezone}` : "";
	return stepView(
		part,
		running,
		<ToolIcon />,
		{ running: `Checking the time${where}`, done: `Checked the time${where}`, notDone: "Time not checked" },
		part.result && note(part.result),
	);
}

function calculateView(part: ToolPart, running: boolean): View | null {
	if (part.name !== "calculate") return null;
	const { expression } = parseJson<{ expression?: string }>(part.args) ?? {};
	const what = expression ? ` ${expression}` : "";
	return stepView(
		part,
		running,
		<ToolIcon />,
		{ running: `Calculating${what}`, done: `Calculated${what}`, notDone: "Not calculated" },
		// Its answer, or why it could not work it out.
		part.result && note(part.result),
	);
}

function accountView(part: ToolPart, running: boolean): View | null {
	const what = ACCOUNT_SETTINGS.get(part.name);
	if (!what) return null;
	const result = parseAccountResult(part.result);
	// A result that is not the JSON we expect (an old chat): the plain view.
	if (part.result !== undefined && !part.failed && !result) return null;
	return stepView(
		part,
		running,
		<CloudIcon />,
		{
			running: `Changing ${what}`,
			done: `${result?.changed ? "Changed" : "Did not change"} ${what}`,
			notDone: `Did not change ${what}`,
		},
		result && note(result.message),
	);
}

function deleteView(part: ToolPart, running: boolean): View | null {
	if (part.name !== DELETE_CHAT_TOOL) return null;
	return stepView(part, running, <TrashIcon />, {
		running: "Deleting this chat",
		done: "Deleted this chat",
		notDone: "Did not delete this chat",
	});
}

type Source = { url: string; title?: string };
type WebResult = { results?: Source[]; pages?: Source[]; error?: string };

function searchView(part: ToolPart, running: boolean): View | null {
	if (part.name !== "web_search") return null;
	const { query } = parseJson<{ query?: string }>(part.args) ?? {};
	const result = parseJson<WebResult>(part.result);
	const what = query ? `“${query}”` : "the web";
	const label = part.failed
		? "Search failed"
		: !result
			? `Searching ${what}`
			: result.error
				? `Search failed: ${result.error}`
				: `Searched ${what} · ${result.results?.length ?? 0} results`;
	return { icon: <GlobeIcon />, label, pulse: part.result === undefined && running, body: sourceList(result?.results) };
}

function readPageView(part: ToolPart, running: boolean): View | null {
	if (part.name !== "read_webpage") return null;
	const { urls } = parseJson<{ urls?: string[] }>(part.args) ?? {};
	const result = parseJson<WebResult>(part.result);
	const count = (n: number) => (n === 1 ? "1 page" : `${n} pages`);
	const label = part.failed
		? "Reading failed"
		: !result
			? `Reading ${count(urls?.length ?? 0)}`
			: result.error
				? `Reading failed: ${result.error}`
				: `Read ${count(result.pages?.length ?? 0)}`;
	return { icon: <GlobeIcon />, label, pulse: part.result === undefined && running, body: sourceList(result?.pages) };
}

function sourceList(sources: Source[] | undefined) {
	if (!sources?.length) return undefined;
	return (
		<ul className="mt-2 flex flex-col gap-1 border-l-2 border-line pl-4 text-sm">
			{sources.map((s) => (
				<li key={s.url} className="truncate">
					<a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">
						{s.title || s.url}
					</a>{" "}
					<span className="text-muted">{hostname(s.url)}</span>
				</li>
			))}
		</ul>
	);
}

// --- Any other tool ---

// Its name in words ("get_stock_price" → "get stock price"). The raw input and
// output are for whoever builds the app, so they show in development only.
function otherView(part: ToolPart, running: boolean): View {
	const name = part.name.replaceAll("_", " ");
	const hasInput = part.args && part.args !== "{}";
	return stepView(
		part,
		running,
		<ToolIcon />,
		{ running: `Running ${name}`, done: `Used ${name}`, notDone: `Did not run ${name}` },
		process.env.NODE_ENV === "development" && (
			<div className="mt-2 flex flex-col gap-2 rounded-xl bg-code p-3 font-mono text-xs wrap-break-word text-muted">
				<span className="whitespace-pre-wrap">input: {hasInput ? part.args : "none"}</span>
				<span className="whitespace-pre-wrap">output: {part.result}</span>
			</div>
		),
	);
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
