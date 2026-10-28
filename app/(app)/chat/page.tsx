import { Suspense } from "react";
import { requireUser } from "@/lib/dal";
import { threadIdFor } from "@/lib/chat-persistence";
import { Chat } from "@/components/chat";

async function UserChat() {
	const user = await requireUser();
	// The thread id comes from the session, so a reload always finds the same thread.
	return <Chat threadId={threadIdFor(user.id)} />;
}

export default function ChatPage() {
	return (
		<div className="flex flex-col gap-6">
			<h1 className="text-2xl font-semibold">Chat</h1>
			<Suspense fallback={<p className="text-sm text-zinc-500">Loading chat...</p>}>
				<UserChat />
			</Suspense>
		</div>
	);
}
