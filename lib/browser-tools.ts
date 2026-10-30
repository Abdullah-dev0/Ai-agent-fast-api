import { queryTable, summarize, toTable, type CsvQuery, type Table } from "./csv";

// Tools the agent runs in the browser, because only the browser has what they need.
// The server pauses the run (interrupt() in agent-server/tools.py), useAgentChat
// calls the tool here, and what it returns goes back as the tool's result.

// A tool's result goes to the model, so failing means returning { error }: the
// model can then ask the user instead of the whole reply failing.
export type BrowserToolResult = Record<string, unknown>;

// Browsers can leave the permission question open for as long as the user ignores
// it, and the chat cannot go on until the tool answers.
const TIMEOUT_MS = 30_000;

// file.text() holds the whole file in memory.
const MAX_CSV_BYTES = 50 * 1024 * 1024;

// Rounded to about 1 km: enough for the weather, and it is all that gets saved with
// the chat and sent to the model.
function getLocation(): Promise<BrowserToolResult> {
	return new Promise((resolve) => {
		if (!navigator.geolocation) return resolve({ error: "This browser cannot share its location." });
		navigator.geolocation.getCurrentPosition(
			({ coords }) =>
				resolve({ latitude: Number(coords.latitude.toFixed(2)), longitude: Number(coords.longitude.toFixed(2)) }),
			(e) =>
				resolve({
					error: e.code === e.PERMISSION_DENIED ? "The user did not allow the location." : "The location is not available.",
				}),
			{ timeout: TIMEOUT_MS },
		);
	});
}

// The file each chat has open. Only in this tab's memory: it never goes to the server,
// and a reload forgets it, so query_csv then tells the model to ask for it again.
const openFiles = new Map<string, Table>();

/** The end of open_csv, once the user has picked a file in the card (CsvPicker). */
export async function openCsv(threadId: string, file: File): Promise<BrowserToolResult> {
	if (file.size > MAX_CSV_BYTES) return { error: "The file is over 50 MB, too big to read here." };
	try {
		const table = toTable(file.name, await file.text());
		openFiles.set(threadId, table);
		return summarize(table);
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

async function queryCsv(threadId: string, args: Record<string, unknown>): Promise<BrowserToolResult> {
	const table = openFiles.get(threadId);
	if (!table) return { error: "No file is open: the page was reloaded or none was chosen. Call open_csv first." };
	return queryTable(table, args as CsvQuery);
}

type BrowserTool = (threadId: string, args: Record<string, unknown>) => Promise<BrowserToolResult>;

const BROWSER_TOOLS: Record<string, BrowserTool> = { get_location: getLocation, query_csv: queryCsv };

// These need a click: browsers only open a file picker from one, so the page shows
// a card and answers when the user is done. No timeout, the user may take a while.
export const needsUser = (name: string) => name === "open_csv";

/** Always answers, so a broken or ignored tool cannot leave the chat paused. */
export async function runBrowserTool(
	name: string,
	threadId: string,
	args: Record<string, unknown>,
): Promise<BrowserToolResult> {
	const tool = BROWSER_TOOLS[name];
	if (!tool) return { error: `This page has no tool called ${name}.` };
	const timeout = new Promise<BrowserToolResult>((resolve) =>
		setTimeout(() => resolve({ error: "The browser did not answer in time." }), TIMEOUT_MS),
	);
	try {
		return await Promise.race([tool(threadId, args), timeout]);
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}
