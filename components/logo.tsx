export function Logo({ size = 32 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
			<circle cx="16" cy="16" r="16" fill="currentColor" />
			<path d="M16 7c.7 5.2 3.8 8.3 9 9-5.2.7-8.3 3.8-9 9-.7-5.2-3.8-8.3-9-9 5.2-.7 8.3-3.8 9-9z" className="fill-background" />
		</svg>
	);
}
