// What open_folder, read_files and write_file do with a folder on the user's disk,
// through the browser's File System Access API. The browser only checks that the path
// is inside the folder the user picked, so every other safety rule is here. The
// browser has no undo: once a write closes, the old version is gone.

export type OpenFolder = {
	root: FileSystemDirectoryHandle;
	// When each file was last modified, as of the agent's last read. A write is
	// refused if the file has changed since, or was never read.
	seen: Map<string, number>;
};

export type DiffLine = { type: "same" | "add" | "remove"; text: string };

// One read can be this big. Nothing is cut: an agent that saw half a file and wrote
// it back would destroy the other half.
const MAX_READ_BYTES = 200 * 1024;
const MAX_READS = 5;
const MAX_LISTED = 500;
// The diff table has one cell per pair of lines. Past this, show a full replacement.
const MAX_DIFF_CELLS = 4_000_000;
const BACKUP_DIR = ".agent-backups";

const BLOCKED_DIRS = new Set([
	".git",
	"node_modules",
	".next",
	".venv",
	"venv",
	"__pycache__",
	"dist",
	"build",
	BACKUP_DIR,
]);
const BLOCKED_FILES = /^(\.env.*|.*\.(pem|key|pfx|p12)|id_(rsa|ed25519|ecdsa).*|\.npmrc|\.netrc|credentials.*|secrets?(\..*)?)$/i;

/** Turns a model's path into "a/b.txt". Throws on anything outside the folder. */
export function cleanPath(path: string): string {
	const parts = path.replace(/\\/g, "/").replace(/^(\.\/)+/, "").split("/");
	if (/^[a-z]:$/i.test(parts[0]) || parts.some((p) => p === "" || p === "." || p === ".."))
		throw new Error(`${path} is not a path inside the open folder.`);
	return parts.join("/");
}

/** Secrets and generated folders: never listed, read or written. */
export function isBlocked(path: string): boolean {
	const parts = path.split("/");
	return BLOCKED_FILES.test(parts.at(-1) ?? "") || parts.some((p) => BLOCKED_DIRS.has(p.toLowerCase()));
}

function checkedPath(path: string): string {
	const clean = cleanPath(path);
	if (isBlocked(clean)) throw new Error(`${clean} is off limits: it may hold secrets, or it is a generated folder.`);
	return clean;
}

const isNotFound = (e: unknown) => e instanceof DOMException && e.name === "NotFoundError";

async function findFile(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle | null> {
	const parts = path.split("/");
	const name = parts.pop()!;
	try {
		let dir = root;
		for (const part of parts) dir = await dir.getDirectoryHandle(part);
		return await dir.getFileHandle(name);
	} catch (e) {
		if (isNotFound(e)) return null;
		throw e;
	}
}

async function createFile(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
	const parts = path.split("/");
	const name = parts.pop()!;
	let dir = root;
	for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
	return dir.getFileHandle(name, { create: true });
}

async function writeText(file: FileSystemFileHandle, text: string) {
	// The real file only changes on close, so a crash here leaves the original whole.
	const writable = await file.createWritable();
	await writable.write(text);
	await writable.close();
}

/** Throws if the file is too big or not text. */
async function readText(file: File): Promise<string> {
	if (file.size > MAX_READ_BYTES) throw new Error(`It is over ${MAX_READ_BYTES / 1024} KB, too big to read whole.`);
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (bytes.includes(0)) throw new Error("It is not a text file.");
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("It is not a text file.");
	}
}

/** What the model gets from open_folder: paths and sizes, no contents. */
export async function listFiles(root: FileSystemDirectoryHandle) {
	const files: { path: string; bytes: number }[] = [];
	let hidden = 0;
	let truncated = false;
	const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
		for await (const [name, handle] of dir.entries()) {
			if (files.length >= MAX_LISTED) {
				truncated = true;
				return;
			}
			const path = `${prefix}${name}`;
			if (isBlocked(path)) hidden++;
			else if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, `${path}/`);
			else files.push({ path, bytes: (await (handle as FileSystemFileHandle).getFile()).size });
		}
	};
	await walk(root, "");
	files.sort((a, b) => a.path.localeCompare(b.path));
	return { folder: root.name, files, hidden, truncated };
}

/** One failed file gets its own error, so the others still come back. */
export async function readFiles(folder: OpenFolder, paths: string[]) {
	if (paths.length > MAX_READS) throw new Error(`Read at most ${MAX_READS} files at a time.`);
	return {
		files: await Promise.all(
			paths.map(async (path) => {
				try {
					const clean = checkedPath(path);
					const handle = await findFile(folder.root, clean);
					if (!handle) return { path, error: "There is no such file." };
					const file = await handle.getFile();
					const content = await readText(file);
					folder.seen.set(clean, file.lastModified);
					return { path: clean, content };
				} catch (e) {
					return { path, error: e instanceof Error ? e.message : String(e) };
				}
			}),
		),
	};
}

// What is on disk now, after every check a write has to pass. Runs before the
// review and again on Apply: the file can change while the review card is open.
async function checkWrite(folder: OpenFolder, path: string) {
	const handle = await findFile(folder.root, path);
	const seen = folder.seen.get(path);
	if (!handle) {
		if (seen !== undefined) throw new Error(`${path} was deleted after it was read.`);
		return { handle: null, before: "" };
	}
	if (seen === undefined) throw new Error(`${path} already exists. Read it with read_files before changing it.`);
	const file = await handle.getFile();
	if (file.lastModified !== seen) throw new Error(`${path} changed after it was read. Read it again first.`);
	return { handle, before: await readText(file) };
}

// A model usually writes \n. Keep a Windows file's \r\n, or every line shows as changed.
function matchLineEndings(before: string, content: string): string {
	return before.includes("\r\n") ? content.replace(/\r?\n/g, "\r\n") : content;
}

/** For the review card. Throws if the write would be refused. Changes nothing on disk. */
export async function prepareWrite(folder: OpenFolder, path: string, content: string) {
	const clean = checkedPath(path);
	const { handle, before } = await checkWrite(folder, clean);
	return { path: clean, isNew: !handle, diff: lineDiff(before, matchLineEndings(before, content)) };
}

/** Only after the user pressed Apply. Saves a backup first; no backup, no write. */
export async function applyWrite(folder: OpenFolder, path: string, content: string) {
	const clean = checkedPath(path);
	const { handle, before } = await checkWrite(folder, clean);
	let backup: string | null = null;
	if (handle) {
		backup = `${BACKUP_DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}/${clean}`;
		await writeText(await createFile(folder.root, backup), before);
	}
	const target = handle ?? (await createFile(folder.root, clean));
	await writeText(target, matchLineEndings(before, content));
	// So the agent can change it again without reading back what it just wrote.
	folder.seen.set(clean, (await target.getFile()).lastModified);
	return { path: clean, created: !handle, backup };
}

/** Line by line, the longest common subsequence of the part that differs. */
export function lineDiff(before: string, after: string): DiffLine[] {
	const a = before === "" ? [] : before.split(/\r?\n/);
	const b = after === "" ? [] : after.split(/\r?\n/);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const same = (lines: string[]) => lines.map((text): DiffLine => ({ type: "same", text }));
	const removed = a.slice(start, endA);
	const added = b.slice(start, endB);
	const middle: DiffLine[] = [];
	const n = removed.length;
	const m = added.length;
	if (n * m > MAX_DIFF_CELLS) {
		for (const text of removed) middle.push({ type: "remove", text });
		for (const text of added) middle.push({ type: "add", text });
	} else {
		const table = new Uint32Array((n + 1) * (m + 1));
		const at = (i: number, j: number) => i * (m + 1) + j;
		for (let i = n - 1; i >= 0; i--)
			for (let j = m - 1; j >= 0; j--)
				table[at(i, j)] =
					removed[i] === added[j] ? table[at(i + 1, j + 1)] + 1 : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
		let i = 0;
		let j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && removed[i] === added[j]) {
				middle.push({ type: "same", text: removed[i] });
				i++;
				j++;
			} else if (j < m && (i === n || table[at(i, j + 1)] > table[at(i + 1, j)])) {
				middle.push({ type: "add", text: added[j++] });
			} else {
				middle.push({ type: "remove", text: removed[i++] });
			}
		}
	}
	return [...same(a.slice(0, start)), ...middle, ...same(a.slice(endA))];
}

/** Keeps the changes and a few lines around them, and counts what it leaves out. */
export function collapseDiff(diff: DiffLine[], context = 3): (DiffLine | { type: "skip"; count: number })[] {
	const keep = diff.map(() => false);
	diff.forEach((line, at) => {
		if (line.type === "same") return;
		for (let i = Math.max(0, at - context); i <= Math.min(diff.length - 1, at + context); i++) keep[i] = true;
	});
	const out: (DiffLine | { type: "skip"; count: number })[] = [];
	diff.forEach((line, at) => {
		if (keep[at]) out.push(line);
		else {
			const last = out.at(-1);
			if (last?.type === "skip") last.count++;
			else out.push({ type: "skip", count: 1 });
		}
	});
	return out;
}
