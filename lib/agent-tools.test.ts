import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCOUNT_SETTINGS, DELETE_CHAT_TOOL, parseAccountResult, parseApprovalCard } from "./agent-tools";

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

// The same JSON account_tools.py writes (_result and _card).
describe("parseAccountResult", () => {
	it("reads changed and message", () => {
		expect(parseAccountResult('{"changed": false, "message": "The smallest limit is 1,000 tokens."}')).toEqual({
			changed: false,
			message: "The smallest limit is 1,000 tokens.",
		});
	});

	it("does not read the wording: old plain text is null", () => {
		expect(parseAccountResult("Not changed: nope")).toBeNull();
		expect(parseAccountResult("Display name changed from 'A' to 'B'.")).toBeNull();
	});

	it.each([undefined, "", "null", "[]", '{"changed": "yes", "message": "x"}', '{"changed": true}'])("rejects %j", (text) => {
		expect(parseAccountResult(text)).toBeNull();
	});
});

describe("parseApprovalCard", () => {
	it("reads a title and details", () => {
		expect(parseApprovalCard('{"title": "Change your display name", "details": ["Name: A → B"]}')).toEqual({
			title: "Change your display name",
			details: ["Name: A → B"],
		});
	});

	it("shows a plain sentence as the title", () => {
		const text = "Delete this whole conversation? This cannot be undone.";
		expect(parseApprovalCard(text)).toEqual({ title: text, details: [] });
	});

	it("ignores details that are not strings", () => {
		expect(parseApprovalCard('{"title": "T", "details": ["a", 1, null]}').details).toEqual(["a"]);
	});

	it("treats JSON without a title as plain text", () => {
		expect(parseApprovalCard('{"details": ["a"]}')).toEqual({ title: '{"details": ["a"]}', details: [] });
	});
});
