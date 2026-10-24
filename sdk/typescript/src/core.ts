// Contextwaise core: shrinks a tool result once, at birth, and never changes it after.
//
// Agent loops resend every tool result on every later turn, so a 20K-token test
// log read at turn 3 of a 20-turn task is paid ~17 more times. shrink() gives the
// model a short view of each result: noise removed (shapers.ts), then the parts
// relevant to what the agent was doing (the tool call's arguments), within a token
// budget, with a pointer to get the rest back with expand(). Nothing is lost: the
// original stays in the ledger.
//
// Cache safety: providers bill a repeated prompt start at ~0.1x only while it is
// byte-identical, and newer Claude models reject edited history. So the view of a
// tool call is decided once and replayed from the ledger, by tool call id, every
// time it is asked for again (SDKs rebuild it on later turns, e.g. the AI SDK's
// convertToModelMessages).
//
// Relevance is only judged by the API (Jev). Word matching can't (synonyms, other
// languages): it only orders lines inside a group. Without the API nothing is cut: the model reads the cleaned output
// whole. Cleanup itself is local, structural and safe.

import { isErrorLine, sections as cutSections, shape, tokens, wordOverlap, type Kind } from "@contextwaise/core";
import { connectBackend, type Backend } from "./client.ts";

export type ContextwaiseOptions = {
  /** Token budget for the model's view of one tool result. Default 600. */
  maxTokens?: number;
  /** Tools whose output the model must always see whole. */
  full?: string[];
  /**
   * Per-tool budgets overriding `maxTokens`, e.g. `{ read_file: 1500 }`: files up to
   * that size pass whole (an agent may edit them); larger ones keep the relevant parts.
   */
  budgets?: Record<string, number>;
  /**
   * Your Contextwaise API key (Settings > API keys). Default: the CONTEXTWAISE_API_KEY
   * environment variable. With a key, relevance is judged by the Contextwaise API (Jev:
   * calibrated, intent-aware, decided once per tool call): a cleaned output larger than
   * its budget is sent there in sections, with its intent, to be scored (the app keeps
   * the scores, not the text). Every result is also reported to your dashboard, with
   * sizes and tool names only. Without a key nothing leaves the process: only the local
   * cleanup runs, noise is removed, nothing relevant is ever cut.
   */
  apiKey?: string;
  /** Where your Contextwaise app runs. Default: the CONTEXTWAISE_URL environment variable. Required with an API key. */
  baseUrl?: string;
  /** Groups this agent's results on the dashboard, e.g. "support-triage". */
  agent?: string;
  /** Where originals and decisions live. Default: in memory, the most recent 5,000 tool calls. */
  ledger?: Ledger;
  /** Every decision, for logs and dashboards. */
  onEvent?: (event: ContextwaiseEvent) => void;
};

/**
 * `integration`: which adapter called (e.g. "vercel-ai"), shown on the dashboard. Direct calls report "core".
 * `model`: the model id that will read the result (e.g. "claude-sonnet-4-5"), shown with the agent on the dashboard.
 * `full`: this call's output must reach the model whole (a tool's schema, a list of actions to pick from),
 * like the tools in the `full` option.
 */
export type ShrinkInput = { callId: string; tool: string; args: unknown; output: unknown; integration?: string; model?: string; full?: boolean };

export type SectionLog = { preview: string; tokens: number; score: number; kept: boolean; reason: "relevant" | "error" | "preview" | "low_relevance" | "over_budget" };

export type ShrinkResult = {
  /** What the model reads. */
  text: string;
  /** full: untouched · shaped: noise removed, fits the budget · trimmed: relevant parts only. */
  mode: "full" | "shaped" | "trimmed";
  ref: string;
  kind: Kind;
  tokensBefore: number;
  tokensAfter: number;
  notes: string[];
  sections: SectionLog[];
  scorer: "jev" | "none";
  intent: string;
};

export type LedgerEntry = { tool: string; original: string; result: ShrinkResult };
export interface Ledger {
  get(callId: string): Promise<LedgerEntry | undefined> | LedgerEntry | undefined;
  set(callId: string, entry: LedgerEntry): Promise<void> | void;
}

export type ContextwaiseEvent =
  | { type: "shrink"; callId: string; tool: string; result: ShrinkResult; ms: number }
  | { type: "replay"; callId: string; tool: string; tokensAfter: number }
  | { type: "expand"; ref: string; question?: string; tokens: number }
  /** The API couldn't judge relevance: the model got the cleaned output whole. */
  | { type: "engine_fallback"; callId: string; error: string }
  | { type: "api_error"; message: string };

export type Contextwaise = {
  /** The model's view of a tool result. Same callId, same answer, always. */
  shrink(input: ShrinkInput): Promise<ShrinkResult>;
  /**
   * Records why the agent made a tool call: the text the model wrote just before it
   * ("let me find the auth middleware"). Arguments alone often don't say (`ls .`).
   * SDK adapters call this from the model's response; call it before the result is shrunk.
   * `contextTokens`: the size of the prompt that made the call. A cut must save more the
   * bigger it is, since a wrong cut costs an expand: one more model call resending all of it.
   */
  noteIntent(callId: string, text: string, options?: { contextTokens?: number }): void;
  /**
   * The original output behind a ref, or its parts answering `question`.
   * `contextTokens`: input tokens of the model call that asked for this expand (the
   * provider's usage). Expanding costs one more model call about that size: the dashboard
   * counts it against the savings. Adapters pass it for you.
   */
  expand(ref: string, question?: string, options?: { contextTokens?: number }): Promise<string>;
  /** Sends pending dashboard reports now. Await it before a short-lived process (script, serverless function) exits. */
  flush(): Promise<void>;
};

const EXPAND_BUDGET = 3000;
// How many budgets a cleaned output may use when relevance can't tell its parts apart.
const UNIFORM_KEEP_FACTOR = 3;
// Sections sent to the API for one result: about one per MIN_GROUP_TOKENS of text,
// at most MAX_REMOTE_SECTIONS (the API rejects more than 200). Each section is a Jev
// question (~280 billed tokens, measured), so this keeps scoring near 1.5x the text.
const MIN_GROUP_TOKENS = 1000;
const MAX_REMOTE_SECTIONS = 120;
// The API's per-section limit (LIMITS.sectionChars in the app's src/lib/tool-results.ts).
const MAX_SECTION_CHARS = 20_000;
// Weight of word overlap inside a group scored by the API: orders lines, never decides.
const TIE_BREAK = 0.05;
// Bound on the per-process maps, so a long-running server doesn't grow forever.
const MAX_TRACKED_CALLS = 5000;

const env = (name: string) => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];

export function createContextwaise(options: ContextwaiseOptions = {}): Contextwaise {
  const defaultBudget = options.maxTokens ?? 600;
  const full = new Set(options.full ?? []);
  const ledger = options.ledger ?? memoryLedger();
  const emit = options.onEvent ?? (() => {});
  const refs = new Map<string, string>(); // ref -> callId
  const intents = new Map<string, string>(); // callId -> what the model said before calling
  const shown = new Map<string, Set<number>>(); // callId -> parts the model already has (view and expands)
  const contexts = new Map<string, number>(); // callId -> tokens of the prompt that made the call

  const apiKey = options.apiKey ?? env("CONTEXTWAISE_API_KEY");
  const baseUrl = options.baseUrl ?? env("CONTEXTWAISE_URL");
  if (apiKey && !baseUrl) throw new Error("contextwaise: an API key needs baseUrl (or CONTEXTWAISE_URL): the address of your Contextwaise app.");
  const backend: Backend | null = apiKey ? connectBackend({ apiKey, baseUrl: baseUrl!, agent: options.agent, onError: (message) => emit({ type: "api_error", message }) }) : null;

  async function shrink(input: ShrinkInput): Promise<ShrinkResult> {
    const known = await ledger.get(input.callId);
    if (known) {
      emit({ type: "replay", callId: input.callId, tool: input.tool, tokensAfter: known.result.tokensAfter });
      return known.result;
    }
    const started = performance.now();
    // Compact, as providers send a tool's JSON output: the honest size to measure savings against.
    const original = serialize(input.output);
    const ref = `cw_${hash(input.callId)}`;
    const intent = [intents.get(input.callId), intentOf(input.tool, input.args)].filter(Boolean).join(" · ");
    intents.delete(input.callId);
    const minSaving = Math.max(MIN_TRIM_SAVING, EXPAND_RISK * (contexts.get(input.callId) ?? 0));
    contexts.delete(input.callId);
    const worthCutting = (whole: number, cut: number) => whole - cut >= minSaving && whole - cut >= MIN_TRIM_SHARE * whole;
    const base = { ref, intent, tokensBefore: tokens(original), sections: [] as SectionLog[], scorer: "none" as const };
    const maxTokens = options.budgets?.[input.tool] ?? defaultBudget;

    // The view, from cheapest to most involved: untouched, noise removed, relevant parts.
    const decide = async (): Promise<ShrinkResult> => {
      if (input.full || full.has(input.tool)) {
        return { ...base, text: original, mode: "full", kind: "text", tokensAfter: tokens(original), notes: [input.full ? "this call is set to pass whole" : `"${input.tool}" is set to always pass whole`] };
      }
      const shaped = shape(original);
      const whole = (notes: string[], scorer: ShrinkResult["scorer"] = "none"): ShrinkResult => {
        const text = notes.length ? `${shaped.text}\n[contextwaise: ${notes.join("; ")}. Everything else is shown in full.]` : original;
        return { ...base, text, mode: notes.length ? "shaped" : "full", kind: shaped.kind, tokensAfter: tokens(text), notes, scorer };
      };
      // Nothing to score when no cut would be worth it: the API isn't called.
      if (tokens(shaped.text) <= maxTokens || !worthCutting(tokens(shaped.text), maxTokens)) return whole(shaped.notes);

      const units = cutSections(shaped.kind, shaped.text);
      const scores = await relevance(input.callId, input.tool, intent, units);
      // No relevance, no cut: a guessed cut would silently cost answers.
      if (!scores) return whole(shaped.notes);
      // Every part equally relevant (e.g. "all of Acme's orders"): any cut would be
      // arbitrary and the agent would have to expand it all back. Keep the cleaned
      // output whole when it stays within a few budgets.
      const uniform = Math.max(...scores) - Math.min(...scores) < 0.05;
      if (uniform && tokens(shaped.text) <= maxTokens * UNIFORM_KEEP_FACTOR) return whole([...shaped.notes, "every part equally relevant: kept whole"], "jev");

      const picked = pick(units, scores, maxTokens, shaped.kind);
      // Nothing fits the budget (one part bigger than all of it): an empty view only sends the
      // model to expand, one more call resending the conversation. Send the output instead.
      if (!picked.some((p) => p.kept)) return whole(shaped.notes, "jev");
      const text = `${render(units, picked, shaped.kind)}\n${footer(ref, original, picked.filter((p) => p.kept).length, units.length, omittedSummary(units, picked, shaped.kind), shaped.notes)}`;
      // Errors are kept over budget: the actual cut can be smaller than planned.
      if (!worthCutting(tokens(shaped.text), tokens(text))) return whole(shaped.notes, "jev");
      return { ...base, text, mode: "trimmed", kind: shaped.kind, tokensAfter: tokens(text), notes: shaped.notes, sections: picked, scorer: "jev" };
    };

    // A view must never cost the agent its result: on any failure here, the output passes as is.
    let result = await decide().catch((e: unknown): ShrinkResult => {
      emit({ type: "engine_fallback", callId: input.callId, error: `shrink failed, output passed as is: ${e instanceof Error ? e.message : String(e)}` });
      return { ...base, text: original, mode: "full", kind: "text", tokensAfter: tokens(original), notes: [] };
    });
    // A view is only worth sending if it is smaller: otherwise send the original as is.
    if (result.mode !== "full" && result.tokensAfter >= result.tokensBefore) {
      result = { ...base, text: original, mode: "full", kind: result.kind, tokensAfter: tokens(original), notes: ["no smaller view possible: sent as is"] };
    }
    remember(refs, ref, input.callId);
    await ledger.set(input.callId, { tool: input.tool, original, result });
    const ms = Math.round(performance.now() - started);
    emit({ type: "shrink", callId: input.callId, tool: input.tool, result, ms });
    backend?.report({ type: "result", callId: input.callId, tool: input.tool, integration: input.integration ?? "core", ...(input.model && { model: input.model }), kind: result.kind, mode: result.mode, scorer: result.scorer, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter, ms });
    return result;
  }

  /** Each unit's relevance (0 to 1) to `intent`, judged by the API; null without a key or when it is unavailable. */
  async function relevance(callId: string, tool: string, intent: string, units: string[]): Promise<number[] | null> {
    if (!backend) return null;
    // Jev bills a question per section: hundreds of one-line sections (logs,
    // listings) would cost several times the text itself (measured: 8.9x for a
    // 1,214-line log). Score consecutive groups instead, each line taking its group's
    // score; errors are still kept on their own.
    const groupCount = Math.min(MAX_REMOTE_SECTIONS, Math.max(1, Math.ceil(tokens(units.join("\n")) / MIN_GROUP_TOKENS)));
    const groups = groupConsecutive(units, groupCount);
    // The API rejects a section over MAX_SECTION_CHARS, which would turn relevance off for
    // the whole result: a single huge unit (one minified blob) is scored on its start instead.
    const scores = await backend.score({ callId, tool, intent, sections: groups.map((g) => forScoring(g.text, intent).slice(0, MAX_SECTION_CHARS)) });
    if (!scores) {
      emit({ type: "engine_fallback", callId, error: "relevance API unavailable: cleaned output passed whole" });
      return null;
    }
    // Lines of a group share its score; word overlap breaks the tie inside it (a nudge
    // too small to lift a line over the keep floor on its own).
    const overlap = wordOverlap(intent, units);
    return units.map((_, i) => (1 - TIE_BREAK) * scores[groups.findIndex((g) => i < g.end)] + TIE_BREAK * overlap[i]);
  }

  async function expand(ref: string, question?: string, { contextTokens }: { contextTokens?: number } = {}): Promise<string> {
    const callId = refs.get(ref);
    const entry = callId ? await ledger.get(callId) : undefined;
    if (!entry) return `No output found for ${ref}.`;
    const shaped = shape(entry.original);
    const units = cutSections(shaped.kind, shaped.text);
    // Each question is its own scoring decision, replayed by the API like any tool call.
    const scores = question ? await relevance(`${callId}:x${hash(question)}`, entry.tool, question, units) : null;
    // Parts the model already has, in the view or from an earlier expand, are not sent again:
    // asked twice, expand returns the next most relevant parts, so a model that didn't get what
    // it needed can't loop on the same answer (each loop is a model call resending everything).
    const seen = shown.get(callId!) ?? new Set(entry.result.sections.flatMap((s, i) => (s.kept ? [i] : [])));
    const picked = scores ? pick(units, scores, EXPAND_BUDGET, shaped.kind, seen) : null;
    const nothingNew = picked !== null && seen.size > 0 && !picked.some((p) => p.kept && p.reason !== "preview");
    if (picked && !nothingNew) {
      picked.forEach((p, i) => p.kept && seen.add(i));
      remember(shown, callId!, seen);
    }
    const text = nothingNew
      ? `Nothing more in ${ref} matches that question: its relevant parts are already shown above.`
      : picked
      ? render(units, picked, entry.result.kind)
      : tokens(entry.original) <= EXPAND_BUDGET ? entry.original : `${entry.original.slice(0, EXPAND_BUDGET * 4)}\n… (truncated${question ? ": the part you asked for could not be found right now" : ": ask expand with a question to get a specific part"})`;
    emit({ type: "expand", ref, question, tokens: tokens(text) });
    backend?.report({ type: "expand", callId: callId!, tool: entry.tool, tokens: tokens(text), ...(contextTokens !== undefined && { contextTokens }) });
    return text;
  }

  const noteIntent = (callId: string, text: string, { contextTokens }: { contextTokens?: number } = {}) => {
    if (text.trim()) remember(intents, callId, text.trim().slice(-500));
    if (contextTokens) remember(contexts, callId, contextTokens);
  };

  return { shrink, expand, noteIntent, flush: async () => backend?.flush() };
}

/** An in-memory ledger keeping the most recent `maxEntries` tool calls. */
export function memoryLedger(maxEntries = MAX_TRACKED_CALLS): Ledger {
  const entries = new Map<string, LedgerEntry>();
  return { get: (id) => entries.get(id), set: (id, e) => remember(entries, id, e, maxEntries) };
}

/** Map.set that drops the oldest entry past `max`: Maps iterate in insertion order. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max = MAX_TRACKED_CALLS) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as K);
}

/**
 * The copy of a section sent to be scored: dates, times and long numbers removed.
 * They rarely decide relevance, and dense digits cost Jev up to ~2x the tokens of
 * prose (measured on logs). The model still reads the original lines.
 * Numbers the intent mentions are kept: when the agent asks about ORD-1337, that id
 * is the needle, and masking it would make every order look the same.
 */
function forScoring(text: string, intent: string): string {
  const asked = new Set((intent.match(/\b[0-9a-f]{12,}\b|\d{4,}/gi) ?? []).map((m) => m.toLowerCase()));
  const mask = (m: string) => (asked.has(m.toLowerCase()) ? m : "#");
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]?(\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?/g, "")
    .replace(/\b\d{2}:\d{2}:\d{2}(\.\d+)?\b/g, "")
    .replace(/\b[0-9a-f]{12,}\b/gi, mask)
    .replace(/\d{4,}/g, mask)
    .replace(/[ \t]{2,}/g, " ");
}

/** Joins consecutive units into at most `max` groups of similar size; `end` is each group's exclusive end index. */
function groupConsecutive(units: string[], max: number): { text: string; end: number }[] {
  if (units.length <= max) return units.map((text, i) => ({ text, end: i + 1 }));
  const size = Math.ceil(units.length / max);
  const groups: { text: string; end: number }[] = [];
  for (let i = 0; i < units.length; i += size) groups.push({ text: units.slice(i, i + size).join("\n"), end: Math.min(i + size, units.length) });
  return groups;
}

/** A short, stable id for a tool call id (FNV-1a, base 36). */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// ---- selection ----

/** Keeps error sections, then the most relevant ones, within budget; the rest is dropped. Order is preserved. */
/** `exclude`: parts never to pick (already shown to the model). */
function pick(units: string[], scores: number[], budget: number, kind: Kind, exclude?: ReadonlySet<number>): SectionLog[] {
  const logs: SectionLog[] = units.map((u, i) => ({ preview: u.slice(0, 120), tokens: tokens(u), score: round(scores[i]), kept: false, reason: "low_relevance" }));
  let used = 0;
  const order = units.map((_, i) => i).sort((a, b) => Number(isErrorUnit(units[b], kind)) - Number(isErrorUnit(units[a], kind)) || scores[b] - scores[a] || a - b);
  for (const i of order) {
    if (exclude?.has(i)) continue;
    const error = isErrorUnit(units[i], kind);
    if (!error && scores[i] < MIN_RELEVANCE) continue;
    if (used + logs[i].tokens > budget && used > 0) {
      logs[i].reason = "over_budget";
      continue;
    }
    used += logs[i].tokens;
    Object.assign(logs[i], { kept: true, reason: error ? "error" : "relevant" });
  }
  // Nothing matched the intent: show the start rather than an empty view, so the
  // model sees what kind of output this is and can expand with a better question.
  if (!logs.some((l) => l.kept && l.reason === "relevant")) {
    for (const [i, l] of logs.entries()) {
      if (l.kept || exclude?.has(i)) continue;
      if (used + l.tokens > budget / 2) break;
      used += l.tokens;
      Object.assign(l, { kept: true, reason: "preview" });
    }
  }
  return logs;
}

// A cut must save at least this many tokens, and this share of the cleaned output, or
// the result passes whole. When the model needs a cut part, expand costs one more model
// call resending the whole conversation: a small saving can't pay for that risk.
const MIN_TRIM_SAVING = 1000;
const MIN_TRIM_SHARE = 0.3;
// When the prompt size is known, a cut must also save this share of it: about what a wrong
// cut costs (one expand resends the prompt) times how often cuts get expanded. A cut saves on
// every later step, an expand costs once. At 0.25, agents with big prompts (agentbuilder: 20-50K
// tokens of instructions, tool lists and schemas) never cut even a 13K-token query result.
const EXPAND_RISK = 0.1;

// Below this a section is noise for the current intent: the API's Jev scores put
// "loosely related, not needed" up to ~0.4 and "useful evidence" from 0.5.
const MIN_RELEVANCE = 0.45;

/**
 * A part reporting a problem, kept first. In JSON only an error field counts: an item that merely
 * mentions one ("payment": "failed", "timeout": 30) is data, and would crowd out the relevant ones.
 */
function isErrorUnit(unit: string, kind: Kind): boolean {
  if (kind !== "json") return unit.split("\n").some(isErrorLine);
  const value: unknown = JSON.parse(unit);
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).some((k) => /^(errors?|exception|fault)\b/i.test(k));
}

/**
 * The kept sections in their original order, each gap shown as one line saying which
 * parts are missing ("… lines 12-240 omitted"), so the model knows what it didn't see.
 */
function render(units: string[], picked: SectionLog[], kind: Kind): string {
  const linesLike = kind === "listing" || kind === "log" || kind === "lines";
  const unit = linesLike ? "line" : kind === "json" ? "item" : "section";
  const out: string[] = [];
  let gapStart: number | null = null;
  const closeGap = (end: number) => {
    if (gapStart !== null) out.push(`… ${end === gapStart + 1 ? `${unit} ${gapStart + 1}` : `${unit}s ${gapStart + 1}-${end}`} omitted`);
  };
  units.forEach((u, i) => {
    if (!picked[i].kept) {
      gapStart ??= i;
      return;
    }
    closeGap(i);
    gapStart = null;
    out.push(u);
  });
  closeGap(units.length);
  return out.join(linesLike || kind === "json" ? "\n" : "\n\n");
}

// What the omitted-parts summary shows: at most this many fields, each with few values.
const MAX_SUMMARY_FIELDS = 3;
const MAX_FIELD_VALUES = 4;
const MAX_VALUE_CHARS = 40;
const LOG_LEVEL = /\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/;
const ENVELOPE_KEY = /^\w+\[\d+\]$/;

/** Counts in first-seen order, most frequent first (ties keep that order), as "a ×3, b ×1". */
function countList(values: string[]): { size: number; total: number; text: string } {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const text = [...counts].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ×${n}`).join(", ");
  return { size: counts.size, total: values.length, text };
}

/**
 * What the omitted parts hold, counted in code, so common follow-up questions ("how many
 * are delivered?") are answered without an expand: the values of the omitted JSON items'
 * categorical fields, or the levels of the omitted log lines. Empty when unknown.
 */
function omittedSummary(units: string[], picked: SectionLog[], kind: Kind): string {
  const omitted = units.filter((_, i) => !picked[i].kept);
  if (kind === "log") {
    const levels = omitted.flatMap((line) => LOG_LEVEL.exec(line)?.[1] ?? []);
    return levels.length ? `${omitted.length} lines, ${countList(levels).text}` : "";
  }
  if (kind !== "json") return "";
  const records = omitted.map(record).filter((r) => r !== null);
  const values = new Map<string, string[]>();
  for (const r of records) {
    for (const [key, raw] of Object.entries(r)) {
      const v = typeof raw === "boolean" ? String(raw) : raw;
      if (typeof v === "string" && [...v].length <= MAX_VALUE_CHARS) values.set(key, [...(values.get(key) ?? []), v]);
    }
  }
  const fields = [...values]
    .map(([key, vs]) => ({ key, ...countList(vs) }))
    .filter((f) => f.size <= MAX_FIELD_VALUES && f.total * 2 >= records.length)
    .slice(0, MAX_SUMMARY_FIELDS)
    .map((f) => `${f.key}: ${f.text}`);
  return fields.length ? `${omitted.length} items; ${fields.join("; ")}` : "";
}

/** An omitted JSON unit as an object: an array item, or one under its envelope key (`orders[3]`). */
function record(unit: string): Record<string, unknown> | null {
  let value: unknown = JSON.parse(unit);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1 && ENVELOPE_KEY.test(entries[0][0])) value = entries[0][1];
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Only trimmed views invite expand: an invitation on a view that lost nothing but
 * noise makes careful models spend a whole extra round trip to "check for more".
 */
function footer(ref: string, original: string, kept: number, total: number, omitted: string, notes: string[]): string {
  return `[contextwaise: kept the ${kept} of ${total} parts relevant to this step (of ${tokens(original)} tokens).${omitted ? ` Omitted: ${omitted}.` : ""}${notes.length ? ` Also ${notes.join("; ")}.` : ""} If you need an omitted part, call expand({ ref: "${ref}", question: "<what you need>" })]`;
}

/** What the agent was after when it called the tool: the tool name and every argument value. */
function intentOf(tool: string, args: unknown): string {
  const values: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" || typeof v === "number") values.push(String(v));
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(args);
  return [tool.replace(/[_-]/g, " "), ...values].join(" ");
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A tool's output as the model would get it: text as is, anything else as JSON (`undefined` as null, BigInt as digits). */
function serialize(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output ?? null, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(output); // circular: no provider could send it as JSON either
  }
}
