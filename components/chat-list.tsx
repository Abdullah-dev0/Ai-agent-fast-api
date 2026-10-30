"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { newChat } from "@/lib/actions";
import type { Chat } from "@/lib/dal";

// A row of chats above the page on small screens. On wide ones, a sidebar in the
// free space left of the layout's max-w-3xl column.
export function ChatList({ chats }: { chats: Chat[] }) {
	const params = useParams<{ id?: string }>();
	const current = params.id && decodeURIComponent(params.id);
	return (
		<nav className="flex shrink-0 gap-1 overflow-x-auto py-2 text-sm scrollbar-none xl:fixed xl:top-[calc(3.5rem+1px)] xl:bottom-0 xl:left-0 xl:w-64 xl:flex-col xl:overflow-y-auto xl:border-r xl:border-zinc-200 xl:p-3 dark:xl:border-zinc-800">
			<form action={newChat} className="shrink-0">
				<button
					type="submit"
					className="w-full rounded-lg border border-zinc-200 px-3 py-1.5 text-left font-medium whitespace-nowrap hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
					New chat
				</button>
			</form>
			{chats.map((chat) => (
				<Link
					key={chat.id}
					href={`/agent/${encodeURIComponent(chat.id)}`}
					title={chat.title ?? "New chat"}
					className={`max-w-48 shrink-0 truncate rounded-lg px-3 py-1.5 hover:bg-zinc-100 xl:max-w-none dark:hover:bg-zinc-800 ${
						chat.id === current ? "bg-zinc-100 font-medium dark:bg-zinc-800" : "text-zinc-600 dark:text-zinc-400"
					}`}>
					{chat.title ?? "New chat"}
				</Link>
			))}
		</nav>
	);
}
