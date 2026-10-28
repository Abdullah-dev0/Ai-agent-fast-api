import { Suspense } from "react";
import { requireUser } from "@/lib/dal";
import { CopilotAgent } from "@/components/copilot-agent";

async function UserAgent() {
	const user = await requireUser();
	// From the session, like the /chat page, so each user gets their own thread.
	return <CopilotAgent threadId={`copilot:${user.id}`} />;
}

export default function AgentPage() {
	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-2xl font-semibold">Agent (CopilotKit)</h1>
			<p className="text-sm text-zinc-500">
				A LangGraph agent in Python (agent-server/), with tools for the time, the weather and math.
			</p>
			<Suspense fallback={<p className="text-sm text-zinc-500">Loading agent...</p>}>
				<UserAgent />
			</Suspense>
		</div>
	);
}
