import assert from "node:assert/strict";
import { test } from "node:test";
import { findModel, inputPrice, MODELS, normalizeModelName } from "../src/models.ts";

const settings = { defaultBudget: 6000, aggressiveness: "balanced" as const, qualityGuard: true, inputPricePerMillion: 7 };

test("model names resolve through prefixes, snapshots and aliases", () => {
  assert.equal(findModel("claude-sonnet-5")?.id, "claude-sonnet-5");
  assert.equal(findModel(" Anthropic/Claude-Sonnet-5 ")?.id, "claude-sonnet-5");
  assert.equal(findModel("claude-haiku-4-5-20251001")?.id, "claude-haiku-4-5");
  assert.equal(findModel("gpt-5-2025-08-07")?.id, "gpt-5");
  assert.equal(findModel("mistral-small-2603")?.id, "mistral-small-latest");
  assert.equal(findModel("gpt-5.4")?.id, "gpt-5.4");
  assert.equal(findModel("llama-9"), undefined);
});

test("pricing falls back from request model to default model to custom price", () => {
  const project = (defaultModel: string, customModels = [] as { name: string; inputPerMillion: number }[]) => ({ settings: { ...settings, defaultModel }, customModels });
  assert.deepEqual(inputPrice("gpt-4o", project("claude-sonnet-5")), { model: "gpt-4o", perMillion: 2.5 });
  assert.deepEqual(inputPrice("unknown", project("claude-sonnet-5")), { model: "claude-sonnet-5", perMillion: 2 });
  assert.deepEqual(inputPrice(undefined, project("")), { model: null, perMillion: 7 });
  // Project models price unknown names, override catalog prices, and can be the default.
  const own = [{ name: "llama-4", inputPerMillion: 0.3 }, { name: "gpt-4o", inputPerMillion: 1 }];
  assert.deepEqual(inputPrice("meta/llama-4", project("claude-sonnet-5", own)), { model: "llama-4", perMillion: 0.3 });
  assert.deepEqual(inputPrice("gpt-4o", project("claude-sonnet-5", own)), { model: "gpt-4o", perMillion: 1 });
  assert.deepEqual(inputPrice("unknown", project("llama-4", own)), { model: "llama-4", perMillion: 0.3 });
});

test("names that aren't model ids normalize to empty", () => {
  assert.equal(normalizeModelName("  "), "");
  assert.equal(normalizeModelName("drop table; --"), "");
  assert.equal(normalizeModelName(42), "");
});

test("catalog ids and aliases are unique", () => {
  const names = MODELS.flatMap((m) => [m.id, ...(m.aliases ?? [])]);
  assert.equal(new Set(names).size, names.length);
});

test("Claude Haiku 5.5 is priced (short-context tier)", () => {
  assert.equal(findModel("claude-haiku-5-5")?.inputPerMillion, 0.1);
});
