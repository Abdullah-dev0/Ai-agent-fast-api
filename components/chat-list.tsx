"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { Chat } from "@/lib/dal";

// The user's chats in the sidebar, the open one highlighted.
export function ChatList({ chats }: { chats: Chat[] }) {
	const params = useParams<{ id?: string }>();
	const current = params.id && decodeURIComponent(params.id);
	if (chats.length === 0) return <p className="px-3 py-2 text-sm text-muted">No chats yet.</p>;
	return (
		<ul className="flex flex-col gap-0.5 text-sm">
			{chats.map((chat) => (
				<li key={chat.id}>
					<Link
						href={`/agent/${encodeURIComponent(chat.id)}`}
						title={chat.title ?? "New chat"}
						aria-current={chat.id === current ? "page" : undefined}
						className="block truncate rounded-lg px-3 py-2 hover:bg-hover aria-[current=page]:bg-surface">
						{chat.title ?? "New chat"}
					</Link>
				</li>
			))}
		</ul>
	);
}

export function ChatListSkeleton() {
	return (
		<div className="flex flex-col gap-2 px-3 py-2">
			{[70, 90, 55, 80].map((w) => (
				<div key={w} style={{ width: `${w}%` }} className="h-4 animate-pulse rounded bg-surface" />
			))}
		</div>
	);
}
