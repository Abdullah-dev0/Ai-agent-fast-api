import { AppShell } from "@/components/app-shell";
import { Sidebar } from "@/components/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
	return <AppShell sidebar={<Sidebar />}>{children}</AppShell>;
}
