"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { sidebarRow } from "@/lib/ui";

export function SidebarNav() {
	const pathname = usePathname();
	return (
		<nav className="flex flex-col">
			<Link
				href="/usage"
				aria-current={pathname.startsWith("/usage") ? "page" : undefined}
				className={sidebarRow}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
					<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
				</svg>
				Usage
			</Link>
		</nav>
	);
}
