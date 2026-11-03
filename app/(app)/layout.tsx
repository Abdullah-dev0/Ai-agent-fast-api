import { getUser } from "@/lib/dal";
import { AppShell } from "@/components/app-shell";
import { Sidebar } from "@/components/sidebar";
import { UserProvider } from "@/components/user-provider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
	// Not awaited: the layout does not block on the session lookup.
	// Client components read this promise with use() via useUser().
	const userPromise = getUser();

	return (
		<UserProvider userPromise={userPromise}>
			<AppShell sidebar={<Sidebar />}>{children}</AppShell>
		</UserProvider>
	);
}
