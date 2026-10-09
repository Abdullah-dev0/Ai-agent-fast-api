import { Suspense } from "react";
import { requireUser } from "@/lib/dal";
import { ClientUserCard } from "@/components/client-user-card";

async function SettingsDetails() {
	await requireUser();
	return <ClientUserCard />;
}

export default function SettingsPage() {
	return (
		<div className="flex flex-col gap-6">
			<h1 className="text-2xl font-semibold">Settings</h1>
			<section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
				<p className="mb-4 text-xs text-zinc-500">
					Rendered by a client component using <code>useUser()</code>. The page passes it no props and it makes no
					request.
				</p>
				<Suspense fallback={<p className="text-sm text-zinc-500">Loading...</p>}>
					<SettingsDetails />
				</Suspense>
			</section>
		</div>
	);
}
