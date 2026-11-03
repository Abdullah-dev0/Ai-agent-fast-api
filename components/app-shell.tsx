"use client";

import { useEffect, useState } from "react";

// Sidebar on the left, page on the right. Below md the sidebar is a drawer that
// a button in the corner opens. The sidebar comes from the server as a prop.
export function AppShell({ sidebar, children }: { sidebar: React.ReactNode; children: React.ReactNode }) {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	return (
		<div className="flex h-dvh overflow-hidden">
			{open && (
				<div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-30 bg-black/50 md:hidden" />
			)}
			<aside
				// Any link or button inside the sidebar closes the drawer.
				onClick={(e) => {
					if ((e.target as HTMLElement).closest("a, button[type=submit]")) setOpen(false);
				}}
				className={`fixed inset-y-0 left-0 z-40 flex w-65 flex-col bg-sidebar transition-[translate,visibility] duration-200 md:static md:translate-x-0 md:visible ${
					open ? "translate-x-0" : "invisible -translate-x-full"
				}`}>
				{sidebar}
			</aside>
			<div className="relative flex min-w-0 flex-1 flex-col">
				<button
					type="button"
					aria-label="Open sidebar"
					onClick={() => setOpen(true)}
					className="absolute top-2 left-2 z-20 flex size-10 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-foreground md:hidden">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
						<path d="M4 7h16M4 12h10M4 17h16" />
					</svg>
				</button>
				<main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
			</div>
		</div>
	);
}
