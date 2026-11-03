"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { Chat } from "@/lib/dal";
import { sidebarRow } from "@/lib/ui";

// The user's chats in the sidebar, the open one highlighted.
export function ChatList({ chats }: { chats: Chat[] }) {
	const params = useParams<{ id?: string }>();
	const current = params.id && decodeURIComponent(params.id);
	if (chats.length === 0) return <p className="px-2.5 py-2 text-sm text-muted">No chats yet.</p>;
	return (
		<ul className="flex flex-col">
			{chats.map((chat) => (
				<li key={chat.id}>
					<Link
						href={`/agent/${encodeURIComponent(chat.id)}`}
						title={chat.title ?? "New chat"}
						aria-current={chat.id === current ? "page" : undefined}
						className={sidebarRow}>
						{/* Long titles fade out at the edge instead of ending in "...". */}
						<span className="block min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)]">
							{chat.title ?? "New chat"}
						</span>
					</Link>
				</li>
			))}
		</ul>
	);
}

export function ChatListSkeleton() {
	return (
		<div className="flex flex-col gap-3 px-2.5 py-2">
			{[70, 90, 55, 80].map((w) => (
				<div key={w} style={{ width: `${w}%` }} className="h-4 animate-pulse rounded bg-surface" />
			))}
		</div>
	);
}
