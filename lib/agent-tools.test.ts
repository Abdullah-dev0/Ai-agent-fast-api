import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCOUNT_SETTINGS, DELETE_CHAT_TOOL } from "./agent-tools";

// The page matches these names as strings, so a rename on the Python side would
// otherwise break it without any error.
const server = ["tools.py", "account_tools.py"]
	.map((file) => readFileSync(new URL(`../agent-server/${file}`, import.meta.url), "utf8"))
	.join("\n");

describe("tool names the page relies on", () => {
	it.each([DELETE_CHAT_TOOL, ...ACCOUNT_SETTINGS.keys()])("%s is still a tool in agent-server", (name) => {
		expect(server).toMatch(new RegExp(`def ${name}\\(`));
	});
});
