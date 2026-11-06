import type { RunAgentResumeItem } from "@tanstack/ai-client";
import { ChatClient, stream, type UIMessage } from "@tanstack/ai-react";
import { describe, expect, it } from "vitest";
import type { AgentInterrupt } from "./chat-types";
import { resumeItems, waitingApprovals, withoutReplayedToolCalls } from "./langgraph-approvals";

// An approval request as ag-ui-langgraph sends it: lg_interrupt_to_agui of what
// HumanInTheLoopMiddleware raises.
const approvalInterrupt = {
	id: "int-1",
	reason: "langgraph:interrupt",
	toolCallId: "call-1",
	metadata: {
		langgraph: {
			raw: {
				type: "tool_approval",
				tool_call_id: "call-1",
				name: "update_my_profile",
				args: { name: "Abdul" },
				description: '{"title": "Change your display name", "details": ["Name: A → B"]}',
			},
		},
	},
};

// The SDK behavior langgraph-approvals.ts is built on. If an SDK update changes
// it, these fail: re-read the interrupts docs before changing the code.
describe("TanStack AI with ag-ui-langgraph's approvals", () => {
	// A chat whose first run pauses on the approval; every request's AG-UI input is kept.
	function pausedChat() {
		const requests: { parentRunId?: string; resume?: RunAgentResumeItem[] }[] = [];
		const client = new ChatClient({
			threadId: "thread-1",
			connection: stream(async function* (_messages, _data, _signal, input) {
				requests.push({ parentRunId: input.parentRunId, resume: input.resume as RunAgentResumeItem[] });
				const base = { threadId: input.threadId, runId: input.runId, timestamp: Date.now() };
				yield { type: "RUN_STARTED", ...base } as never;
				yield (requests.length === 1
					? { type: "RUN_FINISHED", ...base, outcome: { type: "interrupt", interrupts: [approvalInterrupt] } }
					: { type: "RUN_FINISHED", ...base }) as never;
			}),
		});
		return { client, requests };
	}

	it("lists the interrupt as unbound, with its metadata kept", async () => {
		const { client } = pausedChat();
		await client.sendMessage("change my name");
		const interrupts = client.getInterrupts();
		expect(interrupts).toHaveLength(1);
		expect(interrupts[0]).toMatchObject({ id: "int-1", kind: "unbound", canResolve: false });
		expect(waitingApprovals(interrupts as readonly AgentInterrupt[], new Map())).toMatchObject([
			{ id: "int-1", toolCallId: "call-1", name: "update_my_profile" },
		]);
	});

	it("sends the raw resume as the next run's AG-UI resume, after the paused run", async () => {
		const { client, requests } = pausedChat();
		await client.sendMessage("change my name");
		const approvals = waitingApprovals(client.getInterrupts() as readonly AgentInterrupt[], new Map());
		expect(await client.resumeInterruptsUnsafe(resumeItems(approvals, true))).toBe(true);
		expect(requests).toHaveLength(2);
		expect(requests[1].resume).toEqual([
			{ interruptId: "int-1", status: "resolved", payload: { type: "approve" } },
		]);
		expect(requests[1].parentRunId).toBeTruthy();
	});
});

describe("waitingApprovals", () => {
	it("leaves out answered calls and interrupts that are not approvals", () => {
		const other = { id: "int-2", metadata: { langgraph: { raw: { type: "question" } } } } as AgentInterrupt;
		const interrupts = [approvalInterrupt, other] as AgentInterrupt[];
		expect(waitingApprovals(interrupts, new Map())).toHaveLength(1);
		const none = waitingApprovals(interrupts, new Map([["call-1", true]]));
		expect(none).toEqual([]);
		// The same empty list each time, so React sees no change.
		expect(waitingApprovals([], new Map())).toBe(none);
	});
});

describe("resumeItems", () => {
	it("rejects every waiting approval in HumanInTheLoopMiddleware's shape", () => {
		const approvals = waitingApprovals([approvalInterrupt] as AgentInterrupt[], new Map());
		expect(resumeItems(approvals, false)).toEqual([
			{ interruptId: "int-1", status: "resolved", payload: { type: "reject" } },
		]);
	});
});

describe("withoutReplayedToolCalls", () => {
	it("keeps the newest copy of a replayed tool call", () => {
		type Part = UIMessage["parts"][number];
		const first = { type: "tool-call", id: "call-1", name: "x", arguments: "{}", state: "input-complete" } as Part;
		const text = { type: "text", content: "hi" } as Part;
		const again = { ...first, state: "complete" } as Part;
		expect(withoutReplayedToolCalls([first, text, again])).toEqual([text, again]);
	});
});
