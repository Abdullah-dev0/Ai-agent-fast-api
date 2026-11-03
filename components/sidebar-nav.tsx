"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
	{ href: "/dashboard", label: "Dashboard", icon: "M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z" },
	{ href: "/profile", label: "Profile", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0" },
	{
		href: "/settings",
		label: "Settings",
		icon: "M4 7h10M18 7h2M4 17h2M10 17h10M16 4v6M8 14v6",
	},
];

export function SidebarNav() {
	const pathname = usePathname();
	return (
		<nav className="flex flex-col gap-0.5 text-sm">
			{LINKS.map(({ href, label, icon }) => (
				<Link
					key={href}
					href={href}
					aria-current={pathname.startsWith(href) ? "page" : undefined}
					className="flex items-center gap-2.5 rounded-lg px-3 py-2 hover:bg-hover aria-[current=page]:bg-surface">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
						<path d={icon} />
					</svg>
					{label}
				</Link>
			))}
		</nav>
	);
}
