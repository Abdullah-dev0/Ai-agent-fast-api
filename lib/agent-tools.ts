// The tool names the page treats specially. They are defined in agent-server
// (tools.py, account_tools.py); lib/agent-tools.test.ts fails if one is renamed there.

// Approved: the page deletes the chat once the reply has ended.
export const DELETE_CHAT_TOOL = "delete_chat_history";

// What each account tool changes, for "Changing your display name". A Map, not an
// object: an object would also "know" names like "constructor".
export const ACCOUNT_SETTINGS = new Map([
	["update_my_profile", "your display name"],
	["set_token_budget", "your monthly token limit"],
]);
