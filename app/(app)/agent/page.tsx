import { Suspense } from "react";
import { redirect } from "next/navigation";
import { listChats, requireUser } from "@/lib/dal";

async function LatestChat() {
	const user = await requireUser();
	const [latest] = await listChats(user.id);
	if (latest) redirect(`/agent/${encodeURIComponent(latest.id)}`);
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
			<h2 className="text-3xl font-semibold tracking-tight">What can I help with?</h2>
			<p className="text-sm text-muted">No chats yet. Start one with New chat.</p>
		</div>
	);
}

// Opens the latest chat. It creates none: a GET can be a link prefetch.
export default function AgentPage() {
	return (
		<Suspense fallback={<p className="animate-pulse pt-16 text-center text-sm text-muted">Loading chat…</p>}>
			<LatestChat />
		</Suspense>
	);
}
