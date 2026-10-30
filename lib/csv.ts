// Reads a CSV and does the calculations for open_csv and query_csv. Plain functions
// with no browser APIs, so they can be tested on their own.

export type Table = { file: string; columns: string[]; rows: string[][] };

export type CsvQuery = {
	op: "count" | "sum" | "mean" | "min" | "max";
	metric?: string | null;
	group_by?: string | null;
	filter_column?: string | null;
	filter_value?: string | null;
	limit?: number;
};

export type CsvResult = {
	file: string;
	op: CsvQuery["op"];
	metric: string | null;
	group_by: string | null;
	rows_matched: number;
	total_groups: number;
	results: { group: string; value: number }[];
};

// Cells go to the model and the page, so one huge cell cannot fill either.
const MAX_CELL_CHARS = 100;
const MAX_RESULTS = 50;
const SAMPLE_ROWS = 3;

const clip = (cell: string) => (cell.length > MAX_CELL_CHARS ? `${cell.slice(0, MAX_CELL_CHARS)}…` : cell);

const toNumber = (cell: string) => (cell.trim() === "" ? NaN : Number(cell));

/** RFC 4180: quoted cells can hold commas, line breaks and "" for a quote. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	const input = text.replace(/^﻿/, ""); // Excel starts its CSVs with a BOM
	for (let i = 0; i < input.length; i++) {
		const c = input[i];
		if (quoted) {
			if (c !== '"') cell += c;
			else if (input[i + 1] === '"') {
				cell += '"';
				i++;
			} else quoted = false;
		} else if (c === '"') quoted = true;
		else if (c === ",") {
			row.push(cell);
			cell = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && input[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += c;
	}
	if (cell !== "" || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((r) => r.some((value) => value.trim() !== ""));
}

/** The first row is the header. Throws if there is nothing to read. */
export function toTable(file: string, text: string): Table {
	const [header, ...rows] = parseCsv(text);
	if (!header || rows.length === 0) throw new Error("The file has no rows under its header.");
	return { file, columns: header.map((name) => name.trim()), rows };
}

/** What the model gets from open_csv: the shape of the file, not the file. */
export function summarize({ file, columns, rows }: Table) {
	return {
		file,
		rows: rows.length,
		columns: columns.map((name, at) => {
			const cells = rows.map((r) => r[at] ?? "").filter((cell) => cell.trim() !== "");
			const numbers = cells.map(toNumber);
			const empty = rows.length - cells.length;
			if (cells.length > 0 && numbers.every((n) => !Number.isNaN(n))) {
				return {
					name,
					type: "number",
					empty,
					min: aggregate("min", numbers),
					max: aggregate("max", numbers),
					mean: aggregate("mean", numbers),
				};
			}
			const counts = new Map<string, number>();
			for (const cell of cells) counts.set(cell, (counts.get(cell) ?? 0) + 1);
			const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5);
			return { name, type: "text", empty, distinct: counts.size, top: top.map(([value]) => clip(value)) };
		}),
		sample: rows.slice(0, SAMPLE_ROWS).map((r) => Object.fromEntries(columns.map((c, at) => [c, clip(r[at] ?? "")]))),
	};
}

// No Math.min(...values): a big file would overflow the call stack.
function aggregate(op: CsvQuery["op"], values: number[]): number {
	if (op === "count") return values.length;
	if (values.length === 0) return 0;
	let result = op === "sum" || op === "mean" ? 0 : values[0];
	for (const value of values) {
		if (op === "sum" || op === "mean") result += value;
		else if (op === "min") result = Math.min(result, value);
		else result = Math.max(result, value);
	}
	if (op === "mean") result /= values.length;
	return Math.round(result * 10_000) / 10_000;
}

/** Runs one calculation. Throws, naming the columns, if the model asks for one that is not there. */
export function queryTable({ file, columns, rows }: Table, query: CsvQuery): CsvResult {
	const { op, metric = null, group_by = null, filter_column = null, filter_value = null, limit = 20 } = query;
	const find = (name: string) => {
		const at = columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
		if (at === -1) throw new Error(`No column called ${name}. The columns are: ${columns.join(", ")}.`);
		return at;
	};
	if (op !== "count" && !metric) throw new Error(`${op} needs a metric column.`);
	const metricAt = metric ? find(metric) : -1;
	const groupAt = group_by ? find(group_by) : -1;
	const filterAt = filter_column ? find(filter_column) : -1;
	const wanted = filter_value?.trim().toLowerCase();

	const matched = rows.filter((r) => filterAt === -1 || (r[filterAt] ?? "").trim().toLowerCase() === wanted);
	const groups = new Map<string, number[]>();
	for (const r of matched) {
		const group = groupAt === -1 ? "All" : (r[groupAt] ?? "").trim() || "(empty)";
		// count counts rows; the others skip cells that are not numbers.
		const value = op === "count" ? 1 : toNumber(r[metricAt] ?? "");
		if (Number.isNaN(value)) continue;
		const values = groups.get(group);
		if (values) values.push(value);
		else groups.set(group, [value]);
	}
	const results = [...groups]
		.map(([group, values]) => ({ group: clip(group), value: aggregate(op, values) }))
		.sort((a, b) => b.value - a.value);
	return {
		file,
		op,
		metric,
		group_by,
		rows_matched: matched.length,
		total_groups: results.length,
		results: results.slice(0, Math.max(1, Math.min(limit, MAX_RESULTS))),
	};
}
