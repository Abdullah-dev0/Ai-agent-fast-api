"use client";

import "@copilotkit/react-core/v2/styles.css";
import { CopilotChat, CopilotKit, useDefaultRenderTool } from "@copilotkit/react-core/v2";

// Shows each tool the agent runs (name, input, result) inside the chat.
function ToolCalls() {
	useDefaultRenderTool({
		render: ({ name, status, parameters, result }) => (
			<details className="my-1 rounded border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-800">
				<summary>{status === "complete" ? `Used ${name}` : `Using ${name}…`}</summary>
				<p>Input: {JSON.stringify(parameters)}</p>
				{result !== undefined && <p>Result: {result}</p>}
			</details>
		),
	});
	return null;
}

export function CopilotAgent({ threadId }: { threadId: string }) {
	return (
		// runtimeUrl is our Next.js route, which defines the "assistant" agent.
		<CopilotKit runtimeUrl="/api/copilotkit" useSingleEndpoint={false}>
			<ToolCalls />
			<div className="h-[70vh] overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
				{/* agentId names the agent; set it here, the provider's agentId was not
				    picked up by CopilotChat in 1.83. threadId keeps one conversation
				    per user, saved by the agent's checkpointer. */}
				<CopilotChat agentId="assistant" threadId={threadId} />
			</div>
		</CopilotKit>
	);
}
