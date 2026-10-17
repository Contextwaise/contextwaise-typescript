// Meters every model call in the demo: tokens, prompt-cache reads and writes, and
// cost, for the request as sent (with Contextwaise) and as it would have been
// without it (raw tool outputs, no expand round trips).
//
// "With" comes from the provider's own usage report (OpenAI reports cached input
// tokens; Anthropic and the simulated model report cache reads and writes). "Without"
// is never sent anywhere: it is replayed through a prompt-cache simulator that
// follows the provider's rules, so it is an estimate.

import type { LanguageModelMiddleware } from "ai";

/** USD per 1M tokens. `cache` picks the provider's caching rules for the estimate. */
export type Pricing = { id: string; name: string; input: number; cacheRead: number; cacheWrite: number; output: number; cache: "anthropic" | "openai" };

export const PRICING: Record<string, Pricing> = {
  // OpenAI, standard tier, prompts up to 272K tokens (developers.openai.com pricing, checked 2026-10-01).
  "gpt-6.1-sol": { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", input: 2, cacheRead: 0.1, cacheWrite: 2, output: 10, cache: "openai" },
  "gpt-6-sol": { id: "gpt-6-sol", name: "GPT-6 Sol", input: 2, cacheRead: 0.2, cacheWrite: 2, output: 10, cache: "openai" },
  "gpt-6-astra": { id: "gpt-6-astra", name: "GPT-6 Astra", input: 10, cacheRead: 1, cacheWrite: 10, output: 50, cache: "openai" },
  "gpt-6-luna": { id: "gpt-6-luna", name: "GPT-6 Luna", input: 0.1, cacheRead: 0.01, cacheWrite: 0.1, output: 0.5, cache: "openai" },
  // Anthropic: cache reads 0.1x input, 5-minute cache writes 1.25x (checked 2026-10-11).
  // Claude Haiku 5.5 prices are for prompts up to 100K tokens; the demo's stay well below.
  "claude-haiku-5-5": { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5, cache: "anthropic" },
  "claude-sonnet-5-5": { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10, cache: "anthropic" },
  // Simulated model, priced like Claude Sonnet 5.5 (cache write 1.25x, read 0.1x).
  simulated: { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (simulated)", input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10, cache: "anthropic" },
};

export type Billing = { tokens: number; cacheRead: number; cacheWrite: number; output: number; cost: number };
/**
 * Where a request's input tokens go. Contextwaise can only shrink `toolResults`;
 * `fixed` (tool definitions + system prompt) and `conversation` (user and model
 * messages) are the same with or without it.
 */
export type Breakdown = { fixed: number; conversation: number; toolResults: number };
export type LlmCallEvent = {
  type: "llm.call";
  step: number;
  said: string;
  toolCalls: { name: string; args: unknown }[];
  with: Billing & { parts: Breakdown };
  without: Billing & { parts: Breakdown };
  /** True when this call exists only to run `expand`: there is no such call without Contextwaise. */
  expandOnly: boolean;
  withEstimated: boolean;
  ms: number;
};

const tokens = (s: string) => Math.ceil(s.length / 4);

/**
 * A provider's prompt cache, simulated: the longest prefix of an earlier request still
 * alive (5 minutes) is billed as a cache read; the rest is a cache write (Anthropic,
 * 1.25x) or plain input (OpenAI, no write premium, caches from 1,024 tokens).
 */
export class PromptCache {
  private entries: { text: string; expires: number }[] = [];
  private pricing: Pricing;
  constructor(pricing: Pricing) {
    this.pricing = pricing;
  }

  bill(rendered: string, outputTokens: number): Billing {
    const now = Date.now();
    this.entries = this.entries.filter((e) => e.expires > now);
    let hit = 0;
    for (const e of this.entries) {
      let i = 0;
      const max = Math.min(e.text.length, rendered.length);
      while (i < max && e.text.charCodeAt(i) === rendered.charCodeAt(i)) i++;
      hit = Math.max(hit, i);
    }
    const min = this.pricing.cache === "openai" ? 1024 : 512;
    const total = tokens(rendered);
    const cacheRead = tokens(rendered.slice(0, hit)) >= min ? tokens(rendered.slice(0, hit)) : 0;
    this.entries.push({ text: rendered, expires: now + 5 * 60_000 });
    return billing(this.pricing, total, cacheRead, total - cacheRead, outputTokens);
  }
}

/**
 * `written`: how many uncached tokens went into the cache, when the provider says
 * (Anthropic bills those 1.25x, the rest at the input price). Unknown, every uncached
 * token counts as written under Anthropic rules: true when the breakpoint ends the request.
 */
function billing(p: Pricing, total: number, cacheRead: number, uncached: number, output: number, written?: number): Billing {
  if (p.cache === "openai") return { tokens: total, cacheRead, cacheWrite: uncached, output, cost: (cacheRead * p.cacheRead + uncached * p.input + output * p.output) / 1e6 };
  const cacheWrite = Math.min(uncached, written ?? uncached);
  return { tokens: total, cacheRead, cacheWrite, output, cost: (cacheRead * p.cacheRead + cacheWrite * p.cacheWrite + (uncached - cacheWrite) * p.input + output * p.output) / 1e6 };
}

type Part = { type: string; toolCallId?: string; toolName?: string; output?: { type: string; value: unknown } };

/** Splits a request's input by part, in tokens, scaled so the parts add up to `total`. */
function breakdown(tools: string, prompt: unknown, total: number): Breakdown {
  let fixed = tokens(tools);
  let conversation = 0;
  let toolResults = 0;
  for (const m of prompt as Message[]) {
    const size = tokens(JSON.stringify(m));
    if (m.role === "system") fixed += size;
    else if (m.role === "tool") toolResults += size;
    else conversation += size;
  }
  const scale = total / (fixed + conversation + toolResults || 1);
  return { fixed: Math.round(fixed * scale), conversation: Math.round(conversation * scale), toolResults: Math.round(toolResults * scale) };
}
type Message = { role: string; content: string | Part[] };

/** The request as it would have been without Contextwaise: raw tool outputs, and no expand round trips. */
export function withoutContextwaise(prompt: unknown, raw: Map<string, string>): unknown {
  const expandIds = new Set<string>();
  const out: Message[] = [];
  for (const m of prompt as Message[]) {
    if (typeof m.content === "string") {
      out.push(m);
      continue;
    }
    const parts = m.content.flatMap((p) => {
      if (p.type === "tool-call" && p.toolName === "expand") {
        expandIds.add(p.toolCallId!);
        return [];
      }
      if (p.type === "tool-result") {
        if (expandIds.has(p.toolCallId!)) return [];
        const original = raw.get(p.toolCallId!);
        return [original === undefined ? p : { ...p, output: { type: "text", value: original } }];
      }
      return [p];
    });
    if (parts.length) out.push({ ...m, content: parts });
  }
  return out;
}

/** Wraps the model to report each call. `rawOutputs` maps tool call ids to raw outputs, for the estimate. */
export function meter(opts: { pricing: Pricing; rawOutputs: Map<string, string>; onCall: (e: LlmCallEvent) => void; simulated: boolean }): LanguageModelMiddleware & { reset(): void } {
  let without = new PromptCache(opts.pricing);
  let step = 0;
  return {
    reset() {
      without = new PromptCache(opts.pricing);
      step = 0;
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const started = performance.now();
      const result = await doGenerate();
      const ms = Math.round(performance.now() - started);
      const u = result.usage;
      const out = u.outputTokens.total ?? 0;
      const total = u.inputTokens.total ?? 0;
      const read = u.inputTokens.cacheRead ?? 0;
      const withBill = billing(opts.pricing, total, read, total - read, out, u.inputTokens.cacheWrite);
      const tools = JSON.stringify(params.tools ?? []);
      const withoutPrompt = withoutContextwaise(params.prompt, opts.rawOutputs);
      const rendered = tools + JSON.stringify(withoutPrompt);
      // Our count is chars/4; the provider's tokenizer differs. Scale the estimate by
      // how far apart the two are on the request actually sent.
      const factor = opts.simulated || !total ? 1 : total / tokens(tools + JSON.stringify(params.prompt));
      let said = "";
      const toolCalls: LlmCallEvent["toolCalls"] = [];
      for (const p of result.content) {
        if (p.type === "text") said += p.text;
        if (p.type === "tool-call") toolCalls.push({ name: p.toolName, args: safeJson(p.input) });
      }
      // Honest estimate. A call that only runs expand has no counterpart without
      // Contextwaise: it costs nothing there. And when the real provider missed its
      // cache, the same request without Contextwaise would have missed it too.
      const expandOnly = toolCalls.length > 0 && toolCalls.every((c) => c.name === "expand");
      const zero: Billing = { tokens: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
      let withoutBill = zero;
      if (!expandOnly) {
        const est = without.bill(rendered, out);
        const t = Math.round(est.tokens * factor);
        const hit = !opts.simulated && read === 0 ? 0 : Math.round(est.cacheRead * factor);
        withoutBill = billing(opts.pricing, t, hit, t - hit, out);
      }
      opts.onCall({
        type: "llm.call",
        step: ++step,
        said,
        toolCalls,
        with: { ...withBill, parts: breakdown(tools, params.prompt, total) },
        without: { ...withoutBill, parts: expandOnly ? { fixed: 0, conversation: 0, toolResults: 0 } : breakdown(tools, withoutPrompt, withoutBill.tokens) },
        expandOnly,
        withEstimated: opts.simulated,
        ms,
      });
      return result;
    },
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
