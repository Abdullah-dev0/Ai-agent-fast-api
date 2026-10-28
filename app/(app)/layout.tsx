import Link from "next/link";
import { Suspense } from "react";
import { getUser } from "@/lib/dal";
import { UserProvider } from "@/components/user-provider";
import { UserMenu, UserMenuSkeleton } from "@/components/user-menu";

export default function AppLayout({ children }: { children: React.ReactNode }) {
	// Not awaited: the layout does not block on the session lookup.
	// Client components read this promise with use() via useUser().
	const userPromise = getUser();

	return (
		<UserProvider userPromise={userPromise}>
			<header className="border-b border-zinc-200 dark:border-zinc-800">
				<div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4">
					<nav className="flex gap-4 text-sm font-medium">
						<Link href="/dashboard">Dashboard</Link>
						<Link href="/profile">Profile</Link>
						<Link href="/settings">Settings</Link>
						<Link href="/chat">Chat</Link>
					</nav>
					<Suspense fallback={<UserMenuSkeleton />}>
						<UserMenu />
					</Suspense>
				</div>
			</header>
			<main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">{children}</main>
		</UserProvider>
	);
}
