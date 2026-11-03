import Link from "next/link";
import { Suspense } from "react";
import { newChat } from "@/lib/actions";
import { sidebarRow } from "@/lib/ui";
import { listChats, requireUser } from "@/lib/dal";
import { ChatList, ChatListSkeleton } from "@/components/chat-list";
import { Logo } from "@/components/logo";
import { SidebarNav } from "@/components/sidebar-nav";
import { UserMenu, UserMenuSkeleton } from "@/components/user-menu";

async function UserChats() {
	const user = await requireUser();
	return <ChatList chats={await listChats(user.id)} />;
}

async function CurrentUserMenu() {
	const { name, email } = await requireUser();
	return <UserMenu name={name} email={email} />;
}

// Everything except the chats and the user is static, so the sidebar shows at once.
export function Sidebar() {
	return (
		<>
			<div className="flex flex-col p-2">
				<Link href="/agent" className="mb-2 flex h-11 items-center gap-2.5 rounded-lg px-2.5 font-semibold hover:bg-hover">
					<Logo size={24} />
					Aragon
				</Link>
				<form action={newChat}>
					<button type="submit" className={sidebarRow}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
							<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
						</svg>
						New chat
					</button>
				</form>
				<Suspense>
					<SidebarNav />
				</Suspense>
			</div>
			<div className="flex min-h-0 flex-1 flex-col px-2 pt-4">
				<h2 className="px-2.5 pb-1.5 text-xs font-medium text-muted">Chats</h2>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<Suspense fallback={<ChatListSkeleton />}>
						<UserChats />
					</Suspense>
				</div>
			</div>
			<div className="p-2">
				<Suspense fallback={<UserMenuSkeleton />}>
					<CurrentUserMenu />
				</Suspense>
			</div>
		</>
	);
}
