import { Suspense } from "react";
import { getUser, requireUser } from "@/lib/dal";

async function AccountAge() {
	const user = await getUser();
	if (!user) return null;
	const days = Math.floor((Date.now() - user.createdAt.getTime()) / 86_400_000);
	return (
		<p className="text-sm text-zinc-500">
			Member for {days} day{days === 1 ? "" : "s"}.
		</p>
	);
}

async function DashboardDetails() {
	const user = await requireUser();
	return (
		<>
			<h1 className="text-2xl font-semibold">Welcome, {user.name}</h1>
			<AccountAge />
		</>
	);
}

export default function DashboardPage() {
	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-2xl font-semibold">Dashboard</h1>
			<Suspense fallback={<p className="text-sm text-zinc-500">Loading account details...</p>}>
				<DashboardDetails />
			</Suspense>
			<p className="rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
				This page called <code>getUser()</code> three times: in the layout, in the page, and in <code>AccountAge</code>.
				Count the <code>[getUser]</code> lines in the server terminal: there are fewer than three, because{" "}
				<code>cache()</code> shares one lookup per render pass.
			</p>
		</div>
	);
}
