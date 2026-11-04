const icon = {
	width: 16,
	height: 16,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 2,
	strokeLinecap: "round",
	strokeLinejoin: "round",
	"aria-hidden": true,
} as const;

export function ArrowUpIcon() {
	return (
		<svg {...icon} width={18} height={18}>
			<path d="M12 19V5M5 12l7-7 7 7" />
		</svg>
	);
}

export function ChevronIcon() {
	return (
		<svg {...icon} width={14} height={14} className="transition-transform group-open:rotate-90">
			<path d="m9 6 6 6-6 6" />
		</svg>
	);
}

export function GlobeIcon() {
	return (
		<svg {...icon} width={14} height={14}>
			<circle cx="12" cy="12" r="9" />
			<path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
		</svg>
	);
}

export function CloudIcon() {
	return (
		<svg {...icon} width={14} height={14}>
			<path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 11a3.5 3.5 0 0 1-.5 7z" />
		</svg>
	);
}

export function ToolIcon() {
	return (
		<svg {...icon} width={14} height={14}>
			<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />
		</svg>
	);
}

export function CopyIcon() {
	return (
		<svg {...icon}>
			<rect x="9" y="9" width="12" height="12" rx="2" />
			<path d="M5 15V5a2 2 0 0 1 2-2h10" />
		</svg>
	);
}

export function CheckIcon() {
	return (
		<svg {...icon}>
			<path d="M20 6 9 17l-5-5" />
		</svg>
	);
}

export function TrashIcon() {
	return (
		<svg {...icon} width={14} height={14}>
			<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
		</svg>
	);
}
