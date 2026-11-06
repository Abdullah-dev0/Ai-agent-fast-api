import type { DynamicToolUIPart, UIMessage } from "ai";
import type { ApprovalCard } from "./agent-tools";

// The shapes the chat page works with (useAgentChat in use-agent-chat.ts).

// How full the model's context is after its latest call (context_usage in
// agent-server/agent.py). limit is null when the model's limit is not known.
export type ContextUsage = { used: number; limit: number | null };

// An AI SDK message, as useChat builds it from the server's stream
// (agent-server/ui_stream.py) and as GET /agent returns it (history.py). Its parts:
// text; reasoning (no text: it stays on the server, only "Thought for 4s"); and
// "dynamic-tool" (the page knows the tools by name, not by type). `data-context`
// is never kept in a message: it only updates the meter.
export type ChatMessage = UIMessage<unknown, { context: ContextUsage }>;

export type ToolPart = DynamicToolUIPart;

// What GET /agent returns (main.py): the saved chat, with any approval still waiting.
export type SavedChat = { messages: ChatMessage[]; context: ContextUsage | null };

// How hard the model thinks before a reply: Gemini's levels (agent-server/agent.py).
// A value, not only a type: the selector lists these, and ThinkingLevel comes from it.
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// A tool waiting for the user's OK (HumanInTheLoopMiddleware in agent.py).
export type Approval = {
	// The interrupt's id: the answer is sent back under it.
	id: string;
	toolCallId: string;
	name: string;
	// What the card says: parseApprovalCard of the tool's description.
	card: ApprovalCard;
};
