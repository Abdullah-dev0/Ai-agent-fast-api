// The tool names the page treats specially. They are defined in agent-server
// (tools.py, account_tools.py); lib/agent-tools.test.ts fails if one is renamed there.

// Approved: the tool deletes the chat on the server, and the page then leaves it.
export const DELETE_CHAT_TOOL = "delete_chat_history";

// What the account tools answer with: `_result()` in account_tools.py, as JSON.
// Anything else (an old chat, a changed format) is null, and the page shows it raw.
type AccountResult = { changed: boolean; message: string };

export function parseAccountResult(text: string | undefined): AccountResult | null {
	const value = parseObject(text);
	if (typeof value?.changed !== "boolean" || typeof value.message !== "string") return null;
	return { changed: value.changed, message: value.message };
}

// The text of an approval card: `_card()` in account_tools.py writes JSON. The delete
// tool's description is a plain sentence, which becomes a title with no details.
export type ApprovalCard = { title: string; details: string[] };

export function parseApprovalCard(description: string): ApprovalCard {
	const value = parseObject(description);
	if (typeof value?.title !== "string") return { title: description, details: [] };
	const details = Array.isArray(value.details) ? value.details.filter((d) => typeof d === "string") : [];
	return { title: value.title, details };
}

function parseObject(text: string | undefined): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

// What each account tool changes, for "Changing your display name". A Map, not an
// object: an object would also "know" names like "constructor".
export const ACCOUNT_SETTINGS = new Map([
	["update_my_profile", "your display name"],
	["set_token_budget", "your monthly token limit"],
]);
