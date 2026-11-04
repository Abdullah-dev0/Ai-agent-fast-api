import type { Interrupt } from "@ag-ui/core";
import type { ApprovalCard } from "./agent-tools";

// The shapes the chat page works with (useAgentChat in use-agent-chat.ts).

// The same shapes agent-server/history.py returns, so a reloaded chat looks like
// a live one. One assistant message per reply; its parts in the order they came.
export type Part =
	| { type: "text"; id: string; text: string }
	// That the model thought, without what: like ChatGPT, its reasoning text stays on
	// the server (main.py). `startedAt`/`seconds` are measured live (a reloaded chat
	// has neither): "Thought for 4s".
	| { type: "reasoning"; id: string; startedAt?: number; seconds?: number }
	// No `result`: the tool has not run (yet). `failed`: the result is a failure
	// (status "error" on the server), e.g. the user denied the call; its text is
	// then written for the model, not for the user.
	| { type: "tool"; id: string; name: string; args?: string; result?: string; failed?: boolean };

// Tokens a reply used, over all its model calls. Missing if the provider reported none.
export type Usage = { input: number; output: number };

export type ChatMessage = { id: string; role: "user" | "assistant"; parts: Part[]; usage?: Usage };

// How full the model's context is after its latest call (context_usage in
// agent-server/agent.py). limit is null when the model's limit is not known.
export type ContextUsage = { used: number; limit: number | null };

// What GET /agent returns (main.py): the saved chat and any approval still waiting.
export type SavedChat = { messages: ChatMessage[]; context: ContextUsage | null; interrupts: Interrupt[] };

// How hard the model thinks before a reply: Gemini's levels (agent-server/agent.py).
// A value, not only a type: the selector lists these, and ThinkingLevel comes from it.
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// A tool waiting for the user's OK (HumanInTheLoopMiddleware in agent.py).
export type Approval = {
	id: string;
	toolCallId: string;
	name: string;
	args: Record<string, unknown>;
	// What the card says: parseApprovalCard of the tool's description.
	card: ApprovalCard;
};

// What paused the run: LangChain's approval request, which the adapter keeps in an
// AG-UI interrupt's metadata.langgraph.raw (GET /agent returns the same shape). The
// interrupt itself carries the id and toolCallId.
export type ApprovalRequest = { type?: string; name: string; args: Record<string, unknown>; description: string };
