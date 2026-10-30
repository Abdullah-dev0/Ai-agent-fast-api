import { Suspense } from "react";
import { redirect } from "next/navigation";
import { listChats, requireUser } from "@/lib/dal";

async function LatestChat() {
	const user = await requireUser();
	const [latest] = await listChats(user.id);
	if (latest) redirect(`/agent/${encodeURIComponent(latest.id)}`);
	return <p className="pt-10 text-sm text-zinc-500">No chats yet. Start one with New chat.</p>;
}

// Opens the latest chat. It creates none: a GET can be a link prefetch.
export default function AgentPage() {
	return (
		<Suspense fallback={<p className="animate-pulse pt-10 text-sm text-zinc-500">Loading chat…</p>}>
			<LatestChat />
		</Suspense>
	);
}
