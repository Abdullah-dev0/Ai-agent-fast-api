import Link from "next/link";

// No getUser() anywhere in this route group, so this page is prerendered
// as static HTML. Check the build output: it is marked static.
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-4 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">User cache demo</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        This page is static and knows nothing about the user. Sign in to see the
        pages that read the user through one cached <code>getUser()</code>.
      </p>
      <div className="flex gap-3 text-sm font-medium">
        <Link href="/sign-up" className="rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900">
          Create account
        </Link>
        <Link href="/sign-in" className="rounded-md border border-zinc-300 px-4 py-2 dark:border-zinc-700">
          Sign in
        </Link>
        <Link href="/dashboard" className="px-4 py-2 underline">
          Dashboard
        </Link>
      </div>
    </main>
  );
}
