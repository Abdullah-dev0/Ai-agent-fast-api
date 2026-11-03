import { Suspense } from "react";
import { requireUser } from "@/lib/dal";
import { NameForm } from "@/components/name-form";
import { PageContainer } from "@/components/page-container";
import { card } from "@/lib/ui";

async function ProfileDetails() {
	const user = await requireUser();

	return (
		<>
			<dl className={`${card} grid grid-cols-[6rem_1fr] gap-y-3 text-sm sm:grid-cols-[8rem_1fr]`}>
				<dt className="text-muted">Name</dt>
				<dd>{user.name}</dd>
				<dt className="text-muted">Email</dt>
				<dd className="break-all">{user.email}</dd>
				<dt className="text-muted">Joined</dt>
				<dd>{user.createdAt.toDateString()}</dd>
			</dl>
			<section className={card}>
				<NameForm currentName={user.name} />
				<p className="mt-4 text-xs leading-5 text-muted [&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-foreground">
					Saving runs a server action that calls <code>revalidatePath</code>. The name in the sidebar (a client component
					reading context) updates without a reload.
				</p>
			</section>
		</>
	);
}

export default function ProfilePage() {
	return (
		<PageContainer title="Profile">
			<Suspense
				fallback={
					<>
						<div className="h-32 animate-pulse rounded-2xl bg-surface" />
						<div className="h-40 animate-pulse rounded-2xl bg-surface" />
					</>
				}>
				<ProfileDetails />
			</Suspense>
		</PageContainer>
	);
}
