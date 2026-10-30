import { Suspense } from "react";
import { listChats, requireUser } from "@/lib/dal";
import { ChatList } from "@/components/chat-list";

async function UserChats() {
	const user = await requireUser();
	return <ChatList chats={await listChats(user.id)} />;
}

export default function AgentLayout({ children }: { children: React.ReactNode }) {
	return (
		// Exactly fills the screen under the header (h-14 plus its 1px border) so the
		// page never scrolls. -my-10 cancels the py-10 from the layout's <main>.
		<div className="-my-10 flex h-[calc(100dvh-3.5rem-1px)] flex-col">
			<Suspense>
				<UserChats />
			</Suspense>
			{children}
		</div>
	);
}
