// Pure helpers for the usage page: no database, no Next, so vitest can run them.

/** US dollars per 1 million tokens. */
type Price = { input: number; output: number };

// Estimates, not an invoice. These are assumed list prices: check your provider's
// price page and edit them. A model that is not here has no known price, and the
// page shows "n/a" for it instead of guessing.
const PRICES: Record<string, Price> = {
	"google_genai/gemini-3.5-flash": { input: 0.3, output: 2.5 },
};

const FREE: Price = { input: 0, output: 0 };

/** Null when the model's price is not known. */
export function priceFor(provider: string, model: string): Price | null {
	// openrouter/free picks a free model per call; those are named "...:free".
	if (provider === "openrouter" && (model === "openrouter/free" || model.endsWith(":free"))) return FREE;
	return PRICES[`${provider}/${model}`] ?? null;
}

/** Estimated dollars for one provider/model, or null when its price is not known. */
export function estimateCost(provider: string, model: string, input: number, output: number): number | null {
	const price = priceFor(provider, model);
	if (!price) return null;
	return (input * price.input + output * price.output) / 1_000_000;
}

/** Adds up costs that may be null. `unpriced` is true if any row had no known price. */
export function sumCosts(costs: (number | null)[]): { total: number; unpriced: boolean } {
	let total = 0;
	let unpriced = false;
	for (const cost of costs) {
		if (cost === null) unpriced = true;
		else total += cost;
	}
	return { total, unpriced };
}

type BudgetStatus = {
	limit: number;
	used: number;
	/** 0 to 1, capped at 1, for the progress bar. */
	fraction: number;
	level: "ok" | "warn" | "over";
};

const WARN_AT = 0.8;

/** Where a user stands against a monthly token limit. */
export function budgetStatus(used: number, limit: number): BudgetStatus {
	const fraction = Math.min(used / limit, 1);
	const level = used >= limit ? "over" : used >= limit * WARN_AT ? "warn" : "ok";
	return { limit, used, fraction, level };
}

type ParsedBudget = { ok: true; limit: number | null } | { ok: false; error: string };

const MIN_BUDGET = 1_000;
const MAX_BUDGET = 10_000_000_000;

/** Reads the budget form field. An empty text field means "no limit" (limit: null); a missing field is an error, so it cannot remove a limit by accident. */
export function parseBudget(raw: FormDataEntryValue | null): ParsedBudget {
	if (typeof raw !== "string") return { ok: false, error: "Enter a whole number of tokens." };
	const text = raw.replace(/[,_\s]/g, "");
	if (text === "") return { ok: true, limit: null };
	const value = Number(text);
	if (!Number.isInteger(value)) return { ok: false, error: "Enter a whole number of tokens." };
	if (value < MIN_BUDGET) return { ok: false, error: `The smallest limit is ${MIN_BUDGET.toLocaleString("en")} tokens.` };
	if (value > MAX_BUDGET) return { ok: false, error: `The largest limit is ${MAX_BUDGET.toLocaleString("en")} tokens.` };
	return { ok: true, limit: value };
}
