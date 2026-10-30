import { describe, expect, it } from "vitest";
import { parseCsv, queryTable, summarize, toTable } from "./csv";

const sales = toTable(
	"sales.csv",
	"region,product,revenue\nNorth,Tea,10\nSouth,Tea,5.5\nNorth,Coffee,20\nSouth,Coffee,not a number\nNorth,Tea,\n",
);

describe("parseCsv", () => {
	it("keeps commas, quotes and line breaks inside quoted cells", () => {
		expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual([
			["a", "b"],
			["x, y", 'say "hi"\nthere'],
		]);
	});

	it("handles a BOM, CRLF, blank lines and no final line break", () => {
		expect(parseCsv("﻿a,b\r\n\r\n1,2\r\n3,4")).toEqual([
			["a", "b"],
			["1", "2"],
			["3", "4"],
		]);
	});
});

describe("toTable", () => {
	it("refuses a file with only a header", () => {
		expect(() => toTable("empty.csv", "a,b\n")).toThrow("no rows");
	});
});

describe("summarize", () => {
	it("gives number stats, text stats and a short sample", () => {
		const table = toTable("n.csv", "n,name\n1,a\n3,a\n,b\n5,c\n");
		const summary = summarize(table);
		expect(summary.rows).toBe(4);
		expect(summary.columns[0]).toEqual({ name: "n", type: "number", empty: 1, min: 1, max: 5, mean: 3 });
		expect(summary.columns[1]).toMatchObject({ type: "text", distinct: 3 });
		expect(summary.sample).toHaveLength(3);
	});

	it("cuts long cells", () => {
		const summary = summarize(toTable("long.csv", `a\n${"x".repeat(500)}\n`));
		expect(String(summary.sample[0].a).length).toBe(101);
	});
});

describe("queryTable", () => {
	it("sums by group, largest first, and skips cells that are not numbers", () => {
		const result = queryTable(sales, { op: "sum", metric: "revenue", group_by: "region" });
		expect(result.results).toEqual([
			{ group: "North", value: 30 },
			{ group: "South", value: 5.5 },
		]);
		expect(result.rows_matched).toBe(5);
	});

	it("counts rows without a metric", () => {
		expect(queryTable(sales, { op: "count", group_by: "product" }).results).toEqual([
			{ group: "Tea", value: 3 },
			{ group: "Coffee", value: 2 },
		]);
	});

	it("filters whatever the case, and matches column names whatever the case", () => {
		const result = queryTable(sales, { op: "mean", metric: "REVENUE", filter_column: "Product", filter_value: "tea" });
		expect(result.results).toEqual([{ group: "All", value: 7.75 }]);
	});

	it("does not overflow on a big file", () => {
		const rows = Array.from({ length: 200_000 }, (_, i) => [String(i)]);
		const result = queryTable({ file: "big.csv", columns: ["n"], rows }, { op: "max", metric: "n" });
		expect(result.results[0].value).toBe(199_999);
	});

	it("limits the results but reports how many groups there were", () => {
		const rows = Array.from({ length: 100 }, (_, i) => [`g${i}`]);
		const result = queryTable({ file: "g.csv", columns: ["g"], rows }, { op: "count", group_by: "g", limit: 500 });
		expect(result.results).toHaveLength(50);
		expect(result.total_groups).toBe(100);
	});

	it("names the real columns when asked for one that is not there", () => {
		expect(() => queryTable(sales, { op: "sum", metric: "profit" })).toThrow("region, product, revenue");
	});

	it("needs a metric for everything but count", () => {
		expect(() => queryTable(sales, { op: "sum" })).toThrow("needs a metric");
	});
});
