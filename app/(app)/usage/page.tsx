import { Suspense } from "react";
import Link from "next/link";
import { getBudget, getTopChats, getUsage, requireUser } from "@/lib/dal";
import { budgetStatus } from "@/lib/usage";
import { BudgetForm } from "@/components/budget-form";
import { PageContainer } from "@/components/page-container";
import { card } from "@/lib/ui";

const number = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const dayLabel = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

// Small amounts matter here (a chat can cost a fraction of a cent), so show more digits below $1.
function money(value: number | null) {
	if (value === null) return "n/a";
	return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
	return (
		<div className={card}>
			<p className="text-sm text-muted">{label}</p>
			<p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
			{hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
		</div>
	);
}

const barColor = { ok: "bg-foreground/80", warn: "bg-amber-500", over: "bg-red-500" };

async function BudgetCard() {
	const user = await requireUser();
	const { used, limit } = await getBudget(user.id);
	const status = limit === null ? null : budgetStatus(used, limit);
	return (
		<section className={`${card} flex flex-col gap-4`}>
			<div>
				<h2 className="text-sm font-medium">Monthly budget</h2>
				<p className="text-sm text-muted">
					{status
						? `${number.format(used)} of ${number.format(status.limit)} tokens used this month (UTC).`
						: `${number.format(used)} tokens used this month (UTC). No limit set.`}
				</p>
			</div>
			{status && (
				<div className="flex flex-col gap-1.5">
					<div
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round(status.fraction * 100)}
						aria-label="Monthly token budget used"
						className="h-2 overflow-hidden rounded-full bg-surface">
						<div style={{ width: `${status.fraction * 100}%` }} className={`h-full ${barColor[status.level]}`} />
					</div>
					{status.level === "warn" && <p className="text-sm text-amber-500">Over 80% of your limit.</p>}
					{status.level === "over" && (
						<p className="text-sm text-red-500">Limit reached. The assistant will not reply until next month or you raise the limit.</p>
					)}
				</div>
			)}
			<BudgetForm limit={limit} />
		</section>
	);
}

async function TopChats() {
	const user = await requireUser();
	const chats = await getTopChats(user.id);
	if (chats.length === 0) return null;
	return (
		<section className={card}>
			<h2 className="mb-3 text-sm font-medium">Most expensive chats</h2>
			<ul className="flex flex-col divide-y divide-line text-sm">
				{chats.map((c) => (
					<li key={c.id} className="flex items-center justify-between gap-4 py-2">
						{c.exists ? (
							<Link href={`/agent/${c.id}`} className="min-w-0 truncate hover:underline">
								{c.title ?? "Untitled chat"}
							</Link>
						) : (
							<span className="min-w-0 truncate text-muted">Deleted chat</span>
						)}
						<span className="shrink-0 tabular-nums text-muted">
							{compact.format(c.tokens)} tokens · {money(c.cost)}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

async function UsageDetails() {
	const user = await requireUser();
	const { totals, cost, days, models } = await getUsage(user.id);
	const peak = Math.max(1, ...days.map((d) => d.input + d.output));

	return (
		<>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Stat label="Total tokens" value={compact.format(totals.input + totals.output)} />
				<Stat
					label="Estimated cost"
					value={money(cost.total)}
					hint={cost.unpriced ? "Some models have no known price" : "At assumed list prices"}
				/>
				<Stat label="Input" value={compact.format(totals.input)} />
				<Stat label="Output" value={compact.format(totals.output)} />
			</div>

			<BudgetCard />
			<TopChats />

			<section className={card}>
				<h2 className="mb-4 text-sm font-medium">Tokens per day</h2>
				<div className="flex h-40 items-end gap-1">
					{days.map((d) => {
						const total = d.input + d.output;
						return (
							<div
								key={d.day}
								title={`${dayLabel.format(new Date(d.day))}: ${number.format(total)} tokens (${number.format(d.input)} in, ${number.format(d.output)} out)`}
								className="flex h-full flex-1 items-end">
								<div
									style={{ height: `${Math.max((total / peak) * 100, total ? 2 : 0)}%` }}
									className="w-full rounded-t bg-foreground/80 hover:bg-foreground"
								/>
							</div>
						);
					})}
				</div>
				<div className="mt-2 flex justify-between text-xs text-muted">
					<span>{dayLabel.format(new Date(days[0].day))}</span>
					<span>{dayLabel.format(new Date(days.at(-1)!.day))}</span>
				</div>
			</section>

			<section className={card}>
				<h2 className="mb-3 text-sm font-medium">By model</h2>
				{models.length === 0 ? (
					<p className="text-sm text-muted">No usage yet. Send a message in a chat and it shows up here.</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead className="text-left text-muted">
								<tr>
									<th className="py-2 pr-4 font-normal">Model</th>
									<th className="py-2 pr-4 text-right font-normal">Calls</th>
									<th className="py-2 pr-4 text-right font-normal">Input</th>
									<th className="py-2 pr-4 text-right font-normal">Output</th>
									<th className="py-2 text-right font-normal">Est. cost</th>
								</tr>
							</thead>
							<tbody>
								{models.map((m) => (
									<tr key={`${m.provider}/${m.model}`} className="border-t border-line">
										<td className="py-2 pr-4">
											{m.model} <span className="text-muted">{m.provider}</span>
										</td>
										<td className="py-2 pr-4 text-right tabular-nums">{number.format(m.calls)}</td>
										<td className="py-2 pr-4 text-right tabular-nums">{number.format(m.input)}</td>
										<td className="py-2 pr-4 text-right tabular-nums">{number.format(m.output)}</td>
										<td className="py-2 text-right tabular-nums">{money(m.cost)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</>
	);
}

export default function UsagePage() {
	return (
		<PageContainer title="Usage">
			<p className="-mt-3 text-sm text-muted">Tokens your chats used over the last 30 days.</p>
			<Suspense
				fallback={
					<>
						<div className="h-24 animate-pulse rounded-2xl bg-surface" />
						<div className="h-56 animate-pulse rounded-2xl bg-surface" />
					</>
				}>
				<UsageDetails />
			</Suspense>
		</PageContainer>
	);
}
