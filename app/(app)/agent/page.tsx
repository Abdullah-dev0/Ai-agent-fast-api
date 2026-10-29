import { Suspense } from "react";
import { requireUser } from "@/lib/dal";
import { AgentChat } from "@/components/agent-chat";

async function UserAgent() {
	const user = await requireUser();
	// One thread per user. The "tanstack:" prefix is from when this page used
	// TanStack's useChat; kept so existing chats still load.
	return <AgentChat threadId={`tanstack:${user.id}`} />;
}

export default function AgentPage() {
	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-2xl font-semibold">Agent</h1>
			<p className="text-sm text-zinc-500">
				A LangGraph agent in Python (agent-server/), streamed over AG-UI to our own useAgentChat hook.
			</p>
			<Suspense fallback={<p className="text-sm text-zinc-500">Loading...</p>}>
				<UserAgent />
			</Suspense>
		</div>
	);
}
