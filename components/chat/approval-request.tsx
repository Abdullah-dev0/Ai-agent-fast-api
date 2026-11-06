import type { ApprovalCard } from "@/lib/agent-tools";

// A tool call waiting for the user's OK, shown where the call is in the reply (like
// the AI SDK's approval-requested tool part). Once answered it becomes a normal
// tool step: denied, running, then done.
export function ApprovalRequest({
	card,
	onAnswer,
	disabled,
}: {
	card: ApprovalCard;
	onAnswer: (approved: boolean) => void;
	disabled: boolean;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-2xl bg-surface p-3 pl-4">
			<div className="flex min-w-0 flex-col gap-0.5 text-sm">
				<p className="font-medium">{card.title || "The agent needs your approval to continue."}</p>
				{/* Detail lines, e.g. "Name: Abdullah → Abdul". */}
				{card.details.map((line) => (
					<p key={line} className="text-muted">
						{line}
					</p>
				))}
			</div>
			<div className="flex shrink-0 gap-2">
				<button
					type="button"
					onClick={() => onAnswer(false)}
					disabled={disabled}
					className="rounded-full bg-hover px-4 py-1.5 text-sm hover:opacity-80 disabled:opacity-50">
					Deny
				</button>
				<button
					type="button"
					onClick={() => onAnswer(true)}
					disabled={disabled}
					className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:opacity-85 disabled:opacity-50">
					Approve
				</button>
			</div>
		</div>
	);
}
