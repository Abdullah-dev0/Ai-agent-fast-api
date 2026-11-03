"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { buttonPrimary, field } from "@/lib/ui";
import { Logo } from "./logo";

const input = `${field} h-12 rounded-full px-5`;

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
    router.push("/agent");
    router.refresh();
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-16">
      <span className="self-center">
        <Logo size={40} />
      </span>
      <h1 className="text-center text-3xl font-semibold tracking-tight">
        {isSignUp ? "Create your account" : "Welcome back"}
      </h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-3 text-base">
        {isSignUp && (
          <input name="name" placeholder="Name" aria-label="Name" autoComplete="name" required minLength={2} className={input} />
        )}
        <input name="email" type="email" placeholder="Email address" aria-label="Email address" autoComplete="email" required className={input} />
        <input
          name="password"
          type="password"
          placeholder="Password"
          aria-label="Password"
          autoComplete={isSignUp ? "new-password" : "current-password"}
          required
          minLength={8}
          className={input}
        />
        {error && <p className="px-2 text-sm text-danger">{error}</p>}
        <button disabled={pending} className={`${buttonPrimary} h-12`}>
          {pending ? "Please wait..." : isSignUp ? "Sign up" : "Sign in"}
        </button>
      </form>
      <p className="text-center text-sm text-muted">
        {isSignUp ? "Already have an account? " : "No account yet? "}
        <Link className="text-foreground underline" href={isSignUp ? "/sign-in" : "/sign-up"}>
          {isSignUp ? "Sign in" : "Sign up"}
        </Link>
      </p>
    </main>
  );
}
