// The model catalog: which LLMs we can price and their input price. This is the
// one place prices live; requests store the price they were costed at, so
// updating a price here never rewrites history.
//
// Prices are USD per 1M input tokens, standard tier: not cached, not batch,
// short-context tier where a provider has one. Checked against each provider's
// pricing page (PRICE_SOURCES) on PRICES_CHECKED.

export const PROVIDERS = ["Anthropic", "OpenAI", "Google", "Mistral", "DeepSeek"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** `outputPerMillion` / `cacheReadPerMillion`: exact prices where checked; otherwise PROVIDER_RATIOS estimates them. */
export type Model = { id: string; name: string; provider: Provider; inputPerMillion: number; outputPerMillion?: number; cacheReadPerMillion?: number; aliases?: string[] };

export const PRICES_CHECKED = "2026-10-14";

export const PRICE_SOURCES: Record<Provider, string> = {
  Anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  OpenAI: "https://developers.openai.com/api/docs/pricing",
  Google: "https://ai.google.dev/gemini-api/docs/pricing",
  Mistral: "https://docs.mistral.ai/models",
  DeepSeek: "https://api-docs.deepseek.com/quick_start/pricing",
};

export const MODELS: Model[] = [
  { provider: "Anthropic", id: "claude-fable-5-1", name: "Claude Fable 5.1", inputPerMillion: 10, cacheReadPerMillion: 0.25 },
  { provider: "Anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", inputPerMillion: 4, cacheReadPerMillion: 0.2 },
  { provider: "Anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", inputPerMillion: 2, cacheReadPerMillion: 0.2 },
  { provider: "Anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", inputPerMillion: 2 },
  { provider: "Anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", inputPerMillion: 0.1, outputPerMillion: 0.5 },
  { provider: "Anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", inputPerMillion: 1 },
  { provider: "Anthropic", id: "claude-fable-5", name: "Claude Fable 5", inputPerMillion: 10 },
  { provider: "Anthropic", id: "claude-opus-5", name: "Claude Opus 5", inputPerMillion: 5 },
  { provider: "Anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8", inputPerMillion: 5 },
  { provider: "Anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7", inputPerMillion: 5 },
  { provider: "Anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6", inputPerMillion: 5 },
  { provider: "Anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5", inputPerMillion: 5 },
  { provider: "Anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", inputPerMillion: 3 },
  { provider: "Anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", inputPerMillion: 3 },

  // OpenAI: price for prompts up to 272K tokens; longer prompts cost 2x on tiered models.
  // GPT-6 family: exact output and cached-input prices, checked 2026-10-01.
  { provider: "OpenAI", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.1 },
  { provider: "OpenAI", id: "gpt-6-astra", name: "GPT-6 Astra", inputPerMillion: 10, outputPerMillion: 50, cacheReadPerMillion: 1 },
  { provider: "OpenAI", id: "gpt-6-sol", name: "GPT-6 Sol", inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2 },
  { provider: "OpenAI", id: "gpt-6-luna", name: "GPT-6 Luna", inputPerMillion: 0.1, outputPerMillion: 0.5, cacheReadPerMillion: 0.01 },
  { provider: "OpenAI", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", inputPerMillion: 4 },
  { provider: "OpenAI", id: "gpt-5.6-terra", name: "GPT-5.6 Terra", inputPerMillion: 2 },
  { provider: "OpenAI", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", inputPerMillion: 0.2 },
  { provider: "OpenAI", id: "gpt-5.5", name: "GPT-5.5", inputPerMillion: 5 },
  { provider: "OpenAI", id: "gpt-5.5-pro", name: "GPT-5.5 Pro", inputPerMillion: 30 },
  { provider: "OpenAI", id: "gpt-5.4", name: "GPT-5.4", inputPerMillion: 2.5 },
  { provider: "OpenAI", id: "gpt-5.4-mini", name: "GPT-5.4 mini", inputPerMillion: 0.75 },
  { provider: "OpenAI", id: "gpt-5.4-nano", name: "GPT-5.4 nano", inputPerMillion: 0.2 },
  { provider: "OpenAI", id: "gpt-5.4-pro", name: "GPT-5.4 Pro", inputPerMillion: 30 },
  { provider: "OpenAI", id: "gpt-5.3-codex", name: "GPT-5.3 Codex", inputPerMillion: 1.75 },
  { provider: "OpenAI", id: "gpt-5.2", name: "GPT-5.2", inputPerMillion: 1.75 },
  { provider: "OpenAI", id: "gpt-5.2-pro", name: "GPT-5.2 Pro", inputPerMillion: 21 },
  { provider: "OpenAI", id: "gpt-5.1", name: "GPT-5.1", inputPerMillion: 1.25 },
  { provider: "OpenAI", id: "gpt-5", name: "GPT-5", inputPerMillion: 1.25 },
  { provider: "OpenAI", id: "gpt-5-mini", name: "GPT-5 mini", inputPerMillion: 0.25 },
  { provider: "OpenAI", id: "gpt-5-nano", name: "GPT-5 nano", inputPerMillion: 0.05 },
  { provider: "OpenAI", id: "gpt-5-pro", name: "GPT-5 Pro", inputPerMillion: 15 },
  { provider: "OpenAI", id: "gpt-4.1", name: "GPT-4.1", inputPerMillion: 2 },
  { provider: "OpenAI", id: "gpt-4.1-mini", name: "GPT-4.1 mini", inputPerMillion: 0.4 },
  { provider: "OpenAI", id: "gpt-4o", name: "GPT-4o", inputPerMillion: 2.5 },
  { provider: "OpenAI", id: "gpt-4o-mini", name: "GPT-4o mini", inputPerMillion: 0.15 },
  { provider: "OpenAI", id: "o3", name: "o3", inputPerMillion: 2 },
  { provider: "OpenAI", id: "o3-pro", name: "o3-pro", inputPerMillion: 20 },

  // Google, checked 2026-10-01. Price for prompts up to 200K tokens where tiered. The
  // 3.6 to 3.8 Flash prices are a promotion that doubles to $1.50 on 2027-01-01.
  { provider: "Google", id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", inputPerMillion: 2, outputPerMillion: 12, aliases: ["gemini-3.1-pro"] },
  { provider: "Google", id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", inputPerMillion: 0.75 },
  { provider: "Google", id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", inputPerMillion: 0.75 },
  { provider: "Google", id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", inputPerMillion: 0.75 },
  { provider: "Google", id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", inputPerMillion: 1.5 },
  { provider: "Google", id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", inputPerMillion: 0.3 },
  { provider: "Google", id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite", inputPerMillion: 0.25 },
  { provider: "Google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", inputPerMillion: 1.25 },
  { provider: "Google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", inputPerMillion: 0.3 },
  { provider: "Google", id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", inputPerMillion: 0.1 },

  { provider: "Mistral", id: "mistral-medium-latest", name: "Mistral Medium 3.5", inputPerMillion: 1.5, aliases: ["mistral-medium-3-5", "mistral-medium-3"] },
  { provider: "Mistral", id: "mistral-large-latest", name: "Mistral Large 3", inputPerMillion: 0.5, aliases: ["mistral-large-2512"] },
  { provider: "Mistral", id: "mistral-small-latest", name: "Mistral Small 4", inputPerMillion: 0.15, aliases: ["mistral-small-2603"] },
  { provider: "Mistral", id: "codestral-latest", name: "Codestral", inputPerMillion: 0.3, aliases: ["codestral-2508"] },
  { provider: "Mistral", id: "ministral-14b-latest", name: "Ministral 3 14B", inputPerMillion: 0.2, aliases: ["ministral-14b-2512"] },
  { provider: "Mistral", id: "ministral-8b-latest", name: "Ministral 3 8B", inputPerMillion: 0.15, aliases: ["ministral-8b-2512"] },
  { provider: "Mistral", id: "ministral-3b-latest", name: "Ministral 3 3B", inputPerMillion: 0.1, aliases: ["ministral-3b-2512"] },

  // DeepSeek bills peak and off-peak (half price). Off-peak covers most of the week,
  // and the lower price keeps "cost avoided" from being overstated.
  { provider: "DeepSeek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", inputPerMillion: 0.66 },
  { provider: "DeepSeek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash", inputPerMillion: 0.15, aliases: ["deepseek-v4-flash"] },
];

export const DEFAULT_MODEL_ID = "claude-sonnet-5";

/**
 * Output and cache prices as multiples of the input price, per provider, for models
 * without exact figures. Used to estimate whether switching models pays off
 * (model routing), never for billing. Anthropic: exact for every current model (output
 * 5x, cache read 0.1x, cache write 1.25x on the 5-minute cache), with the cheaper
 * cache reads of Opus 5.5 and Fable 5.1 set per model above. Others cache
 * automatically with no write premium; their ratios are estimates to replace with
 * checked figures.
 */
const PROVIDER_RATIOS: Record<Provider, { output: number; cacheRead: number; cacheWrite: number }> = {
  Anthropic: { output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  OpenAI: { output: 8, cacheRead: 0.1, cacheWrite: 1 },
  Google: { output: 5, cacheRead: 0.25, cacheWrite: 1 },
  Mistral: { output: 3, cacheRead: 0.1, cacheWrite: 1 },
  DeepSeek: { output: 4, cacheRead: 0.1, cacheWrite: 1 },
};
// A model the project priced itself: only its input price is known.
const UNKNOWN_RATIOS = { output: 4, cacheRead: 0.1, cacheWrite: 1 };

/** A model's prices per 1M tokens, for estimates: input, output, and reading or writing the prompt cache. */
export type ModelCosts = { id: string; name: string; input: number; output: number; cacheRead: number; cacheWrite: number };

export function modelCosts(name: unknown, custom: CustomModel[] = []): ModelCosts | undefined {
  const priced = resolveModel(name, custom);
  if (!priced) return undefined;
  const catalog = priced.source === "catalog" ? findModel(priced.id) : undefined;
  const r = catalog ? PROVIDER_RATIOS[catalog.provider] : UNKNOWN_RATIOS;
  const input = priced.inputPerMillion;
  return {
    id: priced.id,
    name: priced.name,
    input,
    output: catalog?.outputPerMillion ?? input * r.output,
    cacheRead: catalog?.cacheReadPerMillion ?? input * r.cacheRead,
    cacheWrite: input * r.cacheWrite,
  };
}

/** A model the project priced itself: one missing from the catalog, or a negotiated price. */
export type CustomModel = { name: string; inputPerMillion: number };

/** A model name resolved to a price, from the project's own models or the catalog. */
export type PricedModel = { id: string; name: string; inputPerMillion: number; source: "custom" | "catalog" };

const byName = new Map(MODELS.flatMap((m) => [m.id, ...(m.aliases ?? [])].map((n) => [n, m] as const)));

/**
 * The form a model name is stored and matched in: lowercase, no provider prefix
 * ("anthropic/claude-sonnet-5" -> "claude-sonnet-5"). Returns "" for anything
 * that isn't a plausible model name.
 */
export function normalizeModelName(name: unknown): string {
  if (typeof name !== "string") return "";
  const n = name.trim().toLowerCase().replace(/^[a-z0-9-]+\//, "");
  return /^[a-z0-9][a-z0-9._:-]{0,79}$/.test(n) ? n : "";
}

const withoutDate = (n: string) => n.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");

/** Finds a catalog model by the string callers pass to their LLM SDK, dated snapshots included. */
export function findModel(name: unknown): Model | undefined {
  const n = normalizeModelName(name);
  return n ? byName.get(n) ?? byName.get(withoutDate(n)) : undefined;
}

/** Resolves a model name to a price. The project's own models win, so they can override catalog prices. */
export function resolveModel(name: unknown, custom: CustomModel[] = []): PricedModel | undefined {
  const n = normalizeModelName(name);
  if (!n) return undefined;
  const own = custom.find((c) => c.name === n || c.name === withoutDate(n));
  if (own) return { id: own.name, name: own.name, inputPerMillion: own.inputPerMillion, source: "custom" };
  const m = findModel(n);
  return m && { id: m.id, name: m.name, inputPerMillion: m.inputPerMillion, source: "catalog" };
}

/** The project settings that price a request: a default model, and the price for models without one. */
export type PricingSettings = { defaultModel?: string; inputPricePerMillion: number };

/** The price a request is costed at: its own model, else the project's default model, else the custom price. */
export function inputPrice(requested: unknown, project: { settings: PricingSettings; customModels?: CustomModel[] }): { model: string | null; perMillion: number } {
  const model = resolveModel(requested, project.customModels) ?? resolveModel(project.settings.defaultModel, project.customModels);
  return model ? { model: model.id, perMillion: model.inputPerMillion } : { model: null, perMillion: project.settings.inputPricePerMillion };
}

export const fmtPrice = (perMillion: number) => `$${perMillion.toFixed(2)}`;
