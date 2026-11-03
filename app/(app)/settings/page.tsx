import { Suspense } from "react";
import { requireUser } from "@/lib/dal";
import { ClientUserCard } from "@/components/client-user-card";
import { PageContainer } from "@/components/page-container";
import { card } from "@/lib/ui";

async function SettingsDetails() {
	await requireUser();
	return <ClientUserCard />;
}

export default function SettingsPage() {
	return (
		<PageContainer title="Settings">
			<section className={card}>
				<p className="mb-4 text-xs leading-5 text-muted [&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-foreground">
					Rendered by a client component using <code>useUser()</code>. The page passes it no props and it makes no
					request.
				</p>
				<Suspense fallback={<div className="h-20 animate-pulse rounded-xl bg-surface" />}>
					<SettingsDetails />
				</Suspense>
			</section>
		</PageContainer>
	);
}
