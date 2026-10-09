import { Suspense } from "react";
import { requireUser } from "@/lib/dal";
import { NameForm } from "@/components/name-form";

async function ProfileDetails() {
	const user = await requireUser();

	return (
		<>
			<dl className="grid grid-cols-[8rem_1fr] gap-y-2 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
				<dt className="text-zinc-500">Name</dt>
				<dd>{user.name}</dd>
				<dt className="text-zinc-500">Email</dt>
				<dd>{user.email}</dd>
				<dt className="text-zinc-500">Joined</dt>
				<dd>{user.createdAt.toDateString()}</dd>
			</dl>
			<section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
				<NameForm currentName={user.name} />
				<p className="mt-3 text-xs text-zinc-500">
					Saving runs a server action that calls <code>revalidatePath</code>. The name in the header (a client component
					reading context) updates without a reload.
				</p>
			</section>
		</>
	);
}

export default function ProfilePage() {
	return (
		<div className="flex flex-col gap-6">
			<h1 className="text-2xl font-semibold">Profile</h1>
			<Suspense fallback={<p className="text-sm text-zinc-500">Loading profile...</p>}>
				<ProfileDetails />
			</Suspense>
		</div>
	);
}
