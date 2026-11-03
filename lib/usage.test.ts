import { describe, expect, it } from "vitest";
import { budgetStatus, estimateCost, parseBudget, priceFor, sumCosts } from "./usage";

describe("estimateCost", () => {
	it("prices input and output separately, per million tokens", () => {
		// 1M in at $0.30 + 2M out at $2.50
		expect(estimateCost("google_genai", "gemini-3.5-flash", 1_000_000, 2_000_000)).toBeCloseTo(5.3);
	});

	it("is zero for free OpenRouter models", () => {
		expect(estimateCost("openrouter", "openrouter/free", 500, 500)).toBe(0);
		expect(estimateCost("openrouter", "meta/some-model:free", 500, 500)).toBe(0);
	});

	it("is null, not zero, for a model with no known price", () => {
		expect(priceFor("openrouter", "paid/model")).toBeNull();
		expect(estimateCost("openrouter", "paid/model", 100, 100)).toBeNull();
	});
});

describe("sumCosts", () => {
	it("adds known costs and flags the unknown ones", () => {
		expect(sumCosts([1, 2, null])).toEqual({ total: 3, unpriced: true });
		expect(sumCosts([1, 2])).toEqual({ total: 3, unpriced: false });
		expect(sumCosts([])).toEqual({ total: 0, unpriced: false });
	});
});

describe("budgetStatus", () => {
	it("is ok below 80%, warns from 80%, and is over at the limit", () => {
		expect(budgetStatus(799, 1000).level).toBe("ok");
		expect(budgetStatus(800, 1000).level).toBe("warn");
		expect(budgetStatus(999, 1000).level).toBe("warn");
		expect(budgetStatus(1000, 1000).level).toBe("over");
	});

	it("caps the bar at 100% when usage overshoots", () => {
		expect(budgetStatus(2500, 1000).fraction).toBe(1);
		expect(budgetStatus(250, 1000).fraction).toBe(0.25);
	});
});

describe("parseBudget", () => {
	it("treats an empty field as no limit", () => {
		expect(parseBudget("")).toEqual({ ok: true, limit: null });
		expect(parseBudget("  ")).toEqual({ ok: true, limit: null });
	});

	it("does not treat a missing field or a file as 'no limit'", () => {
		expect(parseBudget(null).ok).toBe(false);
		expect(parseBudget(new File([], "x")).ok).toBe(false);
	});

	it("accepts whole numbers, ignoring separators", () => {
		expect(parseBudget("500000")).toEqual({ ok: true, limit: 500000 });
		expect(parseBudget("1,500,000")).toEqual({ ok: true, limit: 1500000 });
	});

	it("rejects decimals, text, and out-of-range values", () => {
		expect(parseBudget("1.5").ok).toBe(false);
		expect(parseBudget("lots").ok).toBe(false);
		expect(parseBudget("-5").ok).toBe(false);
		expect(parseBudget("999").ok).toBe(false);
		expect(parseBudget("99999999999").ok).toBe(false);
	});
});
