import { Suspense } from "react";
import { requireUser } from "@/lib/dal";
import { CopilotAgent } from "@/components/copilot-agent";

// ?thread=<uuid> opens a specific chat; "New chat" sends you to a fresh one.
// Without it you get your main chat, so the URL survives a reload.
async function UserAgent({ searchParams }: Pick<PageProps<"/agent">, "searchParams">) {
	const user = await requireUser();
	const { thread } = await searchParams;
	const chatId = typeof thread === "string" && /^[0-9a-f-]{36}$/.test(thread) ? thread : null;
	// The user id comes from the session, so a URL cannot open another user's chat.
	const threadId = chatId ? `copilot:${user.id}:${chatId}` : `copilot:${user.id}`;
	return <CopilotAgent key={threadId} threadId={threadId} />;
}

export default function AgentPage({ searchParams }: PageProps<"/agent">) {
	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-2xl font-semibold">Agent (CopilotKit)</h1>
			<p className="text-sm text-zinc-500">
				A LangGraph agent in Python (agent-server/), with tools for the time, the weather and math.
			</p>
			<Suspense fallback={<p className="text-sm text-zinc-500">Loading agent...</p>}>
				<UserAgent searchParams={searchParams} />
			</Suspense>
		</div>
	);
}
