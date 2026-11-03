// The column the usage page sits in. On small screens
// the top gap leaves room for the sidebar button.
export function PageContainer({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 max-md:pt-16">
			<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
			{children}
		</div>
	);
}
