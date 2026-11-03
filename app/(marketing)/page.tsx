import Link from "next/link";
import { Logo } from "@/components/logo";
import { buttonPrimary, buttonSecondary } from "@/lib/ui";

// No getUser() anywhere in this route group, so this page is prerendered
// as static HTML. Check the build output: it is marked static.
export default function Home() {
  return (
    <>
      <header className="flex items-center justify-between px-4 py-3">
        <span className="flex items-center gap-2 font-semibold">
          <Logo size={24} />
          Aragon
        </span>
        <div className="flex gap-2 text-sm">
          <Link href="/sign-in" className={`${buttonSecondary} px-4 py-2`}>
            Sign in
          </Link>
          <Link href="/sign-up" className={`${buttonPrimary} px-4 py-2`}>
            Create account
          </Link>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">User cache demo</h1>
        <p className="text-muted">
          This page is static and knows nothing about the user. Sign in to see the
          pages that read the user through one cached{" "}
          <code className="rounded-md bg-surface px-1.5 py-0.5 text-[0.875em] text-foreground">getUser()</code>.
        </p>
        <div className="flex flex-wrap justify-center gap-3 text-sm">
          <Link href="/sign-up" className={buttonPrimary}>
            Create account
          </Link>
          <Link href="/sign-in" className={buttonSecondary}>
            Sign in
          </Link>
          <Link href="/dashboard" className="px-4 py-2.5 font-medium text-muted underline hover:text-foreground">
            Dashboard
          </Link>
        </div>
      </main>
    </>
  );
}
