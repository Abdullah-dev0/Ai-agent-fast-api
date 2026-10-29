import { Suspense } from "react";
import { requireUser } from "@/lib/dal";
import { AgentChat } from "@/components/agent-chat";

async function UserAgent() {
	const user = await requireUser();
	// One thread per user. The "tanstack:" prefix is from when this page used
	// TanStack's useChat; kept so existing chats still load.
	return <AgentChat threadId={`tanstack:${user.id}`} />;
}

// A LangGraph agent in Python (agent-server/), streamed over AG-UI to our own
// useAgentChat hook (lib/use-agent-chat.ts).
export default function AgentPage() {
	return (
		<Suspense fallback={<p className="animate-pulse text-sm text-zinc-500">Loading chat…</p>}>
			<UserAgent />
		</Suspense>
	);
}
