import { Suspense } from "react";
import { getUser, requireUser } from "@/lib/dal";
import { PageContainer } from "@/components/page-container";
import { card } from "@/lib/ui";

async function AccountAge() {
	const user = await getUser();
	if (!user) return null;
	const days = Math.floor((Date.now() - user.createdAt.getTime()) / 86_400_000);
	return (
		<p className="text-sm text-muted">
			Member for {days} day{days === 1 ? "" : "s"}.
		</p>
	);
}

async function DashboardDetails() {
	const user = await requireUser();
	return (
		<section className={`${card} flex flex-col gap-1`}>
			<h2 className="text-lg font-semibold">Welcome, {user.name}</h2>
			<AccountAge />
		</section>
	);
}

export default function DashboardPage() {
	return (
		<PageContainer title="Dashboard">
			<Suspense fallback={<div className="h-24 animate-pulse rounded-2xl bg-surface" />}>
				<DashboardDetails />
			</Suspense>
			<p className={`${card} text-sm leading-6 text-muted [&_code]:rounded-md [&_code]:bg-surface [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.875em] [&_code]:text-foreground`}>
				This page called <code>getUser()</code> three times: in the layout, in the page, and in <code>AccountAge</code>.
				Count the <code>[getUser]</code> lines in the server terminal: there are fewer than three, because{" "}
				<code>cache()</code> shares one lookup per render pass.
			</p>
		</PageContainer>
	);
}
