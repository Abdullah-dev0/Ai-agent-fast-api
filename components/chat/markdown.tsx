import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Markdown styles, applied to the rendered elements inside one wrapper.
export const MARKDOWN =
	"[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-4 [&_strong]:font-semibold [&_a]:underline [&_a]:underline-offset-2 " +
	"[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold " +
	"[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold " +
	"[&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1.5 [&_li]:pl-1 [&_li::marker]:text-muted " +
	"[&_hr]:my-6 [&_hr]:border-line " +
	"[&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:text-muted " +
	"[&_code]:rounded-md [&_code]:bg-surface [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.875em] " +
	"[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-2xl [&_pre]:bg-code [&_pre]:p-4 [&_pre]:text-sm [&_pre]:leading-6 [&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
	"[&_table]:my-4 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-sm [&_th]:border-b [&_th]:border-line [&_th]:py-2 [&_th]:pr-4 [&_th]:text-left [&_th]:font-semibold " +
	"[&_td]:border-b [&_td]:border-line [&_td]:py-2 [&_td]:pr-4";

// Markdown with GitHub extras (tables, strikethrough); links open in a new tab.
export function MarkdownText({ text }: { text: string }) {
	return (
		<Markdown
			remarkPlugins={[remarkGfm]}
			components={{
				a: ({ href, children }) => (
					<a href={href} target="_blank" rel="noreferrer">
						{children}
					</a>
				),
			}}>
			{text}
		</Markdown>
	);
}
