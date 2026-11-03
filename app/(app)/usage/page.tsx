import { Suspense } from "react";
import { getUsage, requireUser } from "@/lib/dal";
import { PageContainer } from "@/components/page-container";
import { card } from "@/lib/ui";

const number = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const dayLabel = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className={card}>
			<p className="text-sm text-muted">{label}</p>
			<p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
		</div>
	);
}

async function UsageDetails() {
	const user = await requireUser();
	const { totals, days, models } = await getUsage(user.id);
	const peak = Math.max(1, ...days.map((d) => d.input + d.output));

	return (
		<>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Stat label="Total tokens" value={compact.format(totals.input + totals.output)} />
				<Stat label="Input" value={compact.format(totals.input)} />
				<Stat label="Output" value={compact.format(totals.output)} />
				<Stat label="Model calls" value={number.format(totals.calls)} />
			</div>

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
									<th className="py-2 text-right font-normal">Output</th>
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
										<td className="py-2 text-right tabular-nums">{number.format(m.output)}</td>
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
