import { Suspense } from "react";
import { requireUser } from "@/lib/dal";
import { TanstackAgent } from "@/components/tanstack-agent";

async function UserAgent() {
	const user = await requireUser();
	return <TanstackAgent threadId={`tanstack:${user.id}`} />;
}

export default function AgentTanstackPage() {
	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-2xl font-semibold">Agent (TanStack useChat)</h1>
			<p className="text-sm text-zinc-500">
				The same Python agent as /agent, called straight from the browser with TanStack&apos;s useChat.
			</p>
			<Suspense fallback={<p className="text-sm text-zinc-500">Loading...</p>}>
				<UserAgent />
			</Suspense>
		</div>
	);
}
