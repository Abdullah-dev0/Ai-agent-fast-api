"use client";

import { useActionState } from "react";
import { setMonthlyBudget, type BudgetResult } from "@/lib/actions";
import { buttonPrimary, field } from "@/lib/ui";

export function BudgetForm({ limit }: { limit: number | null }) {
	const [result, action, pending] = useActionState<BudgetResult, FormData>(setMonthlyBudget, null);
	return (
		<form action={action} className="flex flex-col gap-2">
			<label htmlFor="limit" className="text-sm text-muted">
				Monthly limit in tokens. Leave empty for no limit.
			</label>
			<div className="flex gap-2">
				<input
					id="limit"
					name="limit"
					inputMode="numeric"
					defaultValue={limit ?? ""}
					placeholder="e.g. 500000"
					className={field}
				/>
				<button type="submit" disabled={pending} className={buttonPrimary}>
					{pending ? "Saving…" : "Save"}
				</button>
			</div>
			{result && (
				<p role="status" className={`text-sm ${result.ok ? "text-muted" : "text-red-500"}`}>
					{result.message}
				</p>
			)}
		</form>
	);
}
