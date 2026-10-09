"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const input =
  "w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isSignUp = mode === "sign-up";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));

    const { error } = isSignUp
      ? await authClient.signUp.email({ email, password, name: String(form.get("name")) })
      : await authClient.signIn.email({ email, password });

    if (error) {
      setError(error.message ?? "Something went wrong.");
      setPending(false);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-16">
      <h1 className="text-2xl font-semibold">{isSignUp ? "Create account" : "Sign in"}</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4 text-sm">
        {isSignUp && (
          <label>
            <span className="mb-1 block text-zinc-500">Name</span>
            <input name="name" required minLength={2} className={input} />
          </label>
        )}
        <label>
          <span className="mb-1 block text-zinc-500">Email</span>
          <input name="email" type="email" required className={input} />
        </label>
        <label>
          <span className="mb-1 block text-zinc-500">Password</span>
          <input name="password" type="password" required minLength={8} className={input} />
        </label>
        {error && <p className="text-red-600">{error}</p>}
        <button
          disabled={pending}
          className="rounded-md bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {pending ? "Please wait..." : isSignUp ? "Sign up" : "Sign in"}
        </button>
      </form>
      <p className="text-sm text-zinc-500">
        {isSignUp ? "Already have an account? " : "No account yet? "}
        <Link className="underline" href={isSignUp ? "/sign-in" : "/sign-up"}>
          {isSignUp ? "Sign in" : "Sign up"}
        </Link>
      </p>
    </main>
  );
}
