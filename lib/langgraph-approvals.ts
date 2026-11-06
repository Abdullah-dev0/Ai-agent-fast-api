import type { RunAgentResumeItem } from "@tanstack/ai-client";
import type { UIMessage } from "@tanstack/ai-react";
import { parseApprovalCard } from "./agent-tools";
import type { AgentInterrupt, Approval } from "./chat-types";

// Everything the chat does off TanStack AI's documented path lives here, so an SDK
// update can only break this file (langgraph-approvals.test.ts checks it).
//
// Why it is needed: the approvals come from LangChain's HumanInTheLoopMiddleware
// through ag-ui-langgraph, which sends AG-UI interrupts with no TanStack binding.
// useChat lists them as `kind: 'unbound'`, which it never resolves, and the only
// documented way to add a binding (withInterruptBinding) is a TypeScript server
// helper. So the answer goes out through useChat's raw resume (the docs: "a
// low-level escape hatch"), in the shape ag-ui-langgraph reads.
//
// The other half is on the server: GET /agent in agent-server/main.py names the
// LangGraph checkpoint as the paused run's id, since LangGraph saves no run id.

const NO_APPROVALS: Approval[] = []; // one value, so an empty list never counts as a change

// The approvals still waiting. `decisions` (answers by tool call id) are left out:
// the raw resume skips the step where useChat would mark the call answered, so
// useChat keeps the interrupt until the resumed run ends.
export function waitingApprovals(
	interrupts: readonly AgentInterrupt[],
	decisions: ReadonlyMap<string, boolean>,
): Approval[] {
	const approvals = interrupts.flatMap((i) => {
		const raw = i.metadata?.langgraph?.raw;
		if (raw?.type !== "tool_approval") return [];
		const toolCallId = i.toolCallId ?? raw.tool_call_id ?? "";
		if (decisions.has(toolCallId)) return [];
		return [{ id: i.id, toolCallId, name: raw.name, args: raw.args, card: parseApprovalCard(raw.description) }];
	});
	return approvals.length ? approvals : NO_APPROVALS;
}

// One answer for every waiting approval: AG-UI resumes all open interrupts at once.
// The payload is what HumanInTheLoopMiddleware reads as the decision.
export function resumeItems(approvals: readonly Approval[], approved: boolean): RunAgentResumeItem[] {
	return approvals.map((a) => ({
		interruptId: a.id,
		status: "resolved" as const,
		payload: { type: approved ? "approve" : "reject" },
	}));
}

type Part = UIMessage["parts"][number];

// A run resumed after an approval starts the paused call again (ag-ui-langgraph),
// so useChat has that tool call twice until the end-of-run snapshot. Keeps only
// the newest copy, which has the latest state.
export function withoutReplayedToolCalls(parts: readonly Part[]): Part[] {
	return parts.filter(
		(p, i) => p.type !== "tool-call" || !parts.slice(i + 1).some((q) => q.type === "tool-call" && q.id === p.id),
	);
}
