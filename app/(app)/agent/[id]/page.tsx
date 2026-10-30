import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getChat, requireUser } from "@/lib/dal";
import { AgentChat } from "@/components/agent-chat";

async function UserChat({ params }: { params: Promise<{ id: string }> }) {
	const user = await requireUser();
	const { id } = await params;
	const chat = await getChat(decodeURIComponent(id), user.id);
	if (!chat) notFound();
	// The key gives each chat its own state: switching chats starts the hook fresh.
	return <AgentChat key={chat.id} threadId={chat.id} />;
}

// A LangGraph agent in Python (agent-server/), streamed over AG-UI to our own
// useAgentChat hook (lib/use-agent-chat.ts).
export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
	return (
		<Suspense fallback={<p className="animate-pulse pt-10 text-sm text-zinc-500">Loading chat…</p>}>
			<UserChat params={params} />
		</Suspense>
	);
}
