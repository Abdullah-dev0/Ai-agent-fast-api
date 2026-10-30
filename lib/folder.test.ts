import { beforeEach, describe, expect, it } from "vitest";
import {
	applyWrite,
	cleanPath,
	collapseDiff,
	isBlocked,
	lineDiff,
	listFiles,
	prepareWrite,
	readFiles,
	type OpenFolder,
} from "./folder";

// Just enough of the File System Access API, kept in memory.
let clock = 1000;
const notFound = () => new DOMException("Not found", "NotFoundError");

class FakeFile {
	readonly kind = "file";
	content: string | Uint8Array;
	lastModified = ++clock;
	constructor(
		readonly name: string,
		content: string | Uint8Array = "",
	) {
		this.content = content;
	}
	async getFile() {
		return new File([this.content as BlobPart], this.name, { lastModified: this.lastModified });
	}
	async createWritable() {
		let pending = "";
		return {
			write: async (text: string) => {
				pending = text;
			},
			close: async () => {
				this.content = pending;
				this.lastModified = ++clock;
			},
		};
	}
}

class FakeDir {
	readonly kind = "directory";
	children = new Map<string, FakeDir | FakeFile>();
	constructor(readonly name: string) {}
	async getDirectoryHandle(name: string, options?: { create?: boolean }) {
		let child = this.children.get(name);
		if (!child && options?.create) this.children.set(name, (child = new FakeDir(name)));
		if (!(child instanceof FakeDir)) throw notFound();
		return child;
	}
	async getFileHandle(name: string, options?: { create?: boolean }) {
		let child = this.children.get(name);
		if (!child && options?.create) this.children.set(name, (child = new FakeFile(name)));
		if (!(child instanceof FakeFile)) throw notFound();
		return child;
	}
	async *entries() {
		yield* this.children.entries();
	}
	add(path: string, content: string | Uint8Array = ""): FakeFile {
		const [name, ...rest] = path.split("/");
		if (rest.length === 0) {
			const file = new FakeFile(name, content);
			this.children.set(name, file);
			return file;
		}
		if (!this.children.has(name)) this.children.set(name, new FakeDir(name));
		return (this.children.get(name) as FakeDir).add(rest.join("/"), content);
	}
}

let root: FakeDir;
let folder: OpenFolder;

beforeEach(() => {
	root = new FakeDir("project");
	folder = { root: root as unknown as FileSystemDirectoryHandle, seen: new Map() };
});

const contentOf = (path: string) => {
	let at: FakeDir | FakeFile = root;
	for (const part of path.split("/")) at = (at as FakeDir).children.get(part)!;
	return (at as FakeFile).content;
};
const backups = () => [...root.children.keys()].includes(".agent-backups");

describe("cleanPath", () => {
	it("accepts paths inside the folder and tidies them", () => {
		expect(cleanPath("./src\\a.txt")).toBe("src/a.txt");
	});

	it.each(["../secret.txt", "a/../../b", "/etc/passwd", "C:/Windows/x", "C:\\x", "", "a//b", "a/./b"])(
		"refuses %j",
		(path) => {
			expect(() => cleanPath(path)).toThrow("not a path inside");
		},
	);
});

describe("isBlocked", () => {
	it.each([
		".env",
		".env.local",
		"config/.ENV.production",
		"certs/server.pem",
		"id_rsa",
		"id_ed25519.pub",
		"credentials.json",
		"secrets.yaml",
		".git/config",
		"a/node_modules/x/index.js",
		".agent-backups/old/notes.txt",
	])("blocks %s", (path) => {
		expect(isBlocked(path)).toBe(true);
	});

	it.each(["src/index.ts", "environment.md", "README.md", "keys.txt", "docs/secret-santa.md", "builder.py"])(
		"allows %s",
		(path) => {
			expect(isBlocked(path)).toBe(false);
		},
	);
});

describe("listFiles", () => {
	it("lists files with sizes, hides blocked ones and counts them", async () => {
		root.add("README.md", "hello");
		root.add("src/a.ts", "x");
		root.add(".env", "SECRET=1");
		root.add("node_modules/pkg/index.js");
		expect(await listFiles(folder.root)).toEqual({
			folder: "project",
			files: [
				{ path: "README.md", bytes: 5 },
				{ path: "src/a.ts", bytes: 1 },
			],
			hidden: 2,
			truncated: false,
		});
	});

	it("stops at the limit and says so", async () => {
		for (let i = 0; i < 510; i++) root.add(`f${i}.txt`);
		const result = await listFiles(folder.root);
		expect(result.files).toHaveLength(500);
		expect(result.truncated).toBe(true);
	});
});

describe("readFiles", () => {
	it("returns contents, with an error for each file that cannot be read", async () => {
		root.add("a.txt", "one");
		root.add(".env", "SECRET=1");
		root.add("big.txt", "x".repeat(300 * 1024));
		root.add("image.png", new Uint8Array([137, 80, 0, 71]));
		const { files } = await readFiles(folder, ["a.txt", ".env", "big.txt", "image.png", "../up.txt"]);
		expect(files[0]).toEqual({ path: "a.txt", content: "one" });
		expect(files.slice(1).every((f) => "error" in f)).toBe(true);
		expect(JSON.stringify(files)).not.toContain("SECRET");
	});

	it("says when a file is missing", async () => {
		const { files } = await readFiles(folder, ["none.txt"]);
		expect(files[0]).toEqual({ path: "none.txt", error: "There is no such file." });
	});

	it("refuses more than 5 files at a time", async () => {
		await expect(readFiles(folder, ["1", "2", "3", "4", "5", "6"])).rejects.toThrow("at most 5");
	});

	it("does not mark a failed read as seen", async () => {
		root.add("big.txt", "x".repeat(300 * 1024));
		await readFiles(folder, ["big.txt"]);
		await expect(applyWrite(folder, "big.txt", "small")).rejects.toThrow("Read it with read_files");
		expect(contentOf("big.txt")).toHaveLength(300 * 1024);
	});
});

describe("writes", () => {
	it("refuses to overwrite a file the agent never read", async () => {
		root.add("a.txt", "mine");
		await expect(prepareWrite(folder, "a.txt", "new")).rejects.toThrow("Read it with read_files");
		await expect(applyWrite(folder, "a.txt", "new")).rejects.toThrow("Read it with read_files");
		expect(contentOf("a.txt")).toBe("mine");
	});

	it("refuses if the file changed after it was read, even during the review", async () => {
		const file = root.add("a.txt", "one");
		await readFiles(folder, ["a.txt"]);
		await prepareWrite(folder, "a.txt", "two");
		file.content = "edited by the user";
		file.lastModified = ++clock;
		await expect(applyWrite(folder, "a.txt", "two")).rejects.toThrow("changed after it was read");
		expect(contentOf("a.txt")).toBe("edited by the user");
		expect(backups()).toBe(false);
	});

	it("refuses if the file was deleted after it was read", async () => {
		root.add("a.txt", "one");
		await readFiles(folder, ["a.txt"]);
		root.children.delete("a.txt");
		await expect(applyWrite(folder, "a.txt", "two")).rejects.toThrow("deleted");
		expect(root.children.has("a.txt")).toBe(false);
	});

	it("refuses blocked and outside paths", async () => {
		for (const path of [".env", ".git/hooks/pre-commit", "../outside.txt", ".agent-backups/x"]) {
			await expect(applyWrite(folder, path, "x")).rejects.toThrow();
		}
		expect(root.children.size).toBe(0);
	});

	it("does not change anything while preparing the review", async () => {
		root.add("a.txt", "one");
		await readFiles(folder, ["a.txt"]);
		await prepareWrite(folder, "a.txt", "two");
		expect(contentOf("a.txt")).toBe("one");
		expect(backups()).toBe(false);
	});

	it("backs up the old version, writes, and can write again without a new read", async () => {
		root.add("src/a.txt", "one");
		await readFiles(folder, ["src/a.txt"]);
		const first = await applyWrite(folder, "src/a.txt", "two");
		expect(contentOf("src/a.txt")).toBe("two");
		expect(first.created).toBe(false);
		expect(contentOf(first.backup!)).toBe("one");

		const second = await applyWrite(folder, "src/a.txt", "three");
		expect(contentOf("src/a.txt")).toBe("three");
		expect(contentOf(second.backup!)).toBe("two");
	});

	it("does not touch the file if the backup fails", async () => {
		root.add("a.txt", "one");
		await readFiles(folder, ["a.txt"]);
		root.getDirectoryHandle = async () => {
			throw new Error("disk full");
		};
		await expect(applyWrite(folder, "a.txt", "two")).rejects.toThrow("disk full");
		expect(contentOf("a.txt")).toBe("one");
	});

	it("creates a new file and its folders, with no backup", async () => {
		const result = await applyWrite(folder, "docs/new/notes.md", "hello");
		expect(result).toEqual({ path: "docs/new/notes.md", created: true, backup: null });
		expect(contentOf("docs/new/notes.md")).toBe("hello");
	});

	it("keeps Windows line endings, and the diff shows only the real change", async () => {
		root.add("a.txt", "one\r\ntwo\r\n");
		await readFiles(folder, ["a.txt"]);
		const { diff } = await prepareWrite(folder, "a.txt", "one\ntwo!\n");
		expect(diff.filter((l) => l.type !== "same")).toEqual([
			{ type: "remove", text: "two" },
			{ type: "add", text: "two!" },
		]);
		await applyWrite(folder, "a.txt", "one\ntwo!\n");
		expect(contentOf("a.txt")).toBe("one\r\ntwo!\r\n");
	});
});

describe("lineDiff", () => {
	const marks = (before: string, after: string) =>
		lineDiff(before, after)
			.map((l) => `${{ same: " ", add: "+", remove: "-" }[l.type]}${l.text}`)
			.join("|");

	it("shows no changes for the same text", () => {
		expect(marks("a\nb", "a\nb")).toBe(" a| b");
	});

	it("finds a change in the middle", () => {
		expect(marks("a\nb\nc", "a\nx\nc")).toBe(" a|-b|+x| c");
	});

	it("handles a new file and an emptied file", () => {
		expect(marks("", "a\nb")).toBe("+a|+b");
		expect(marks("a\nb", "")).toBe("-a|-b");
	});

	it("keeps lines that moved around a change", () => {
		expect(marks("a\nb\nc\nd", "b\nc\nd\ne")).toBe("-a| b| c| d|+e");
	});

	it("falls back to a full replacement when a file is too different to compare", () => {
		const before = Array.from({ length: 3000 }, (_, i) => `old${i}`).join("\n");
		const after = Array.from({ length: 3000 }, (_, i) => `new${i}`).join("\n");
		const diff = lineDiff(before, after);
		expect(diff).toHaveLength(6000);
		expect(diff[0].type).toBe("remove");
		expect(diff[3000].type).toBe("add");
	});
});

describe("collapseDiff", () => {
	it("keeps the lines near a change and counts the rest", () => {
		const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
		const after = before.replace("l10", "changed");
		const out = collapseDiff(lineDiff(before, after));
		expect(out[0]).toEqual({ type: "skip", count: 7 });
		expect(out.at(-1)).toEqual({ type: "skip", count: 6 });
		expect(out.filter((l) => l.type === "same")).toHaveLength(6);
	});
});
