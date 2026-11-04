import type { ReactNode } from "react";
import { ACCOUNT_SETTINGS, parseAccountResult } from "@/lib/agent-tools";
import type { Part } from "@/lib/chat-types";
import { ChevronIcon, CloudIcon, GlobeIcon, ToolIcon } from "./icons";

type ToolPart = Extract<Part, { type: "tool" }>;

// How one tool call looks: an icon and a line that opens to show `body`.
// No `body` means there is nothing to open.
type View = { icon: ReactNode; label: ReactNode; pulse?: boolean; body?: ReactNode };

// A denied call streams no result (a reload shows the reason), so below,
// "no result and not running" means the tool did not run.
export function ToolCall({ part, waiting, running }: { part: ToolPart; waiting: boolean; running: boolean }) {
	// The approval card under the reply already says what is being asked.
	if (waiting) return null;

	// Tools we know get a sentence; any other tool shows its name and raw input/output.
	const view =
		weatherView(part, running) ??
		accountView(part, running) ??
		searchView(part, running) ??
		readPageView(part, running) ??
		rawView(part, running);

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

// --- Tools from agent-server/tools.py and account_tools.py ---

function weatherView(part: ToolPart, running: boolean): View | null {
	if (part.name !== "get_weather") return null;
	const icon = <CloudIcon />;
	const { city } = parseJson<{ city?: string | null }>(part.args) ?? {};
	const where = city ? ` in ${city}` : "";
	if (part.result === undefined) {
		return running
			? { icon, label: `Checking the weather${where}`, pulse: true }
			: { icon, label: "Weather not checked" };
	}
	return { icon, label: `Checked the weather${where}`, body: note(part.result) };
}

function accountView(part: ToolPart, running: boolean): View | null {
	const what = ACCOUNT_SETTINGS.get(part.name);
	if (!what) return null;
	const icon = <CloudIcon />;
	if (part.result === undefined) {
		return running ? { icon, label: `Changing ${what}`, pulse: true } : { icon, label: `Did not change ${what}` };
	}
	const result = parseAccountResult(part.result);
	if (!result) return null; // Not the JSON we expect: the raw card shows it as it is.
	return { icon, label: `${result.changed ? "Changed" : "Did not change"} ${what}`, body: note(result.message) };
}

type Source = { url: string; title?: string };
type WebResult = { results?: Source[]; pages?: Source[]; error?: string };

function searchView(part: ToolPart, running: boolean): View | null {
	if (part.name !== "web_search") return null;
	const { query } = parseJson<{ query?: string }>(part.args) ?? {};
	const result = parseJson<WebResult>(part.result);
	const what = query ? `“${query}”` : "the web";
	const label = !result
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
	const label = !result
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

function rawView(part: ToolPart, running: boolean): View {
	const status = part.result !== undefined ? "Used" : running ? "Running" : "Not run:";
	const hasInput = part.args && part.args !== "{}";
	return {
		icon: <ToolIcon />,
		label: (
			<>
				{status} <span className="font-medium">{part.name}</span>
			</>
		),
		pulse: status === "Running",
		body: (
			<div className="mt-2 flex flex-col gap-2 rounded-xl bg-code p-3 font-mono text-xs wrap-break-word text-muted">
				<span className="whitespace-pre-wrap">input: {hasInput ? part.args : "none"}</span>
				{part.result !== undefined && <span className="whitespace-pre-wrap">output: {part.result}</span>}
			</div>
		),
	};
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
