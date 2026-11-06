import type { UIMessage } from "@tanstack/ai-react";
import type { ApprovalCard } from "./agent-tools";

// The shapes the chat page works with (useAgentChat in use-agent-chat.ts).

// A message as TanStack AI's useChat builds it from the stream, and as GET /agent
// returns it (history.py). Its parts the page shows: text, tool-call, tool-result.
// useChat starts a new assistant message after each tool round, so one reply can be
// several assistant messages in a row: the page shows them as one.
export type ChatMessage = UIMessage;

// One tool call as tool-call.tsx shows it: the call and its result put together.
// No `result`: the tool has not run (yet). `failed`: the result is a failure, e.g.
// the user denied the call; its text is then written for the model, not for the user.
export type ToolStep = { id: string; name: string; args?: string; result?: string; failed?: boolean };

// How full the model's context is after its latest call (context_usage in
// agent-server/agent.py). limit is null when the model's limit is not known.
export type ContextUsage = { used: number; limit: number | null };

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

// What paused the run: LangChain's approval request, which ag-ui-langgraph keeps in
// an AG-UI interrupt's metadata.langgraph.raw (GET /agent returns the same shape).
export type ApprovalRequest = {
	type?: string;
	tool_call_id?: string;
	name: string;
	args: Record<string, unknown>;
	description: string;
};

// The part of an AG-UI interrupt the page reads: from GET /agent, or live from
// TanStack's useChat (its "unbound" interrupts carry the same id and metadata).
export type AgentInterrupt = {
	id: string;
	toolCallId?: string;
	metadata?: Readonly<{ langgraph?: { raw?: ApprovalRequest } }>;
};
