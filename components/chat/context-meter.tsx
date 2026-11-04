import type { ContextUsage } from "@/lib/chat-types";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// How much of the model's context the chat has filled, like "12.4K / 200K (6%)".
export function ContextMeter({ context: { used, limit } }: { context: ContextUsage }) {
	const percent = limit ? (used / limit) * 100 : null;
	return (
		<span
			title="How much of the model's memory for this chat is used. A new chat starts empty."
			className="flex items-center gap-2 text-xs text-muted">
			{percent !== null && (
				<span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface">
					<span
						style={{ width: `${Math.min(percent, 100)}%` }}
						className={`block h-full rounded-full ${percent >= 80 ? "bg-danger" : "bg-muted"}`}
					/>
				</span>
			)}
			{limit
				? `${compact.format(used)} / ${compact.format(limit)} (${percent! < 1 ? "<1" : Math.round(percent!)}%)`
				: `${compact.format(used)} tokens`}
		</span>
	);
}
