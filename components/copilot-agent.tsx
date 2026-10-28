"use client";

import { CopilotKit } from "@copilotkit/react-core/v2";
import { AgentChat } from "./agent-chat";

export function CopilotAgent({ threadId }: { threadId: string }) {
	return (
		// The provider talks to our Next.js route, which defines the "assistant"
		// agent. AgentChat draws the chat itself instead of CopilotKit's <CopilotChat>.
		<CopilotKit runtimeUrl="/api/copilotkit" useSingleEndpoint={false}>
			<AgentChat threadId={threadId} />
		</CopilotKit>
	);
}
