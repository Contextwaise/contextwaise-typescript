// The selection engine: pure functions that turn scored candidates into the
// context that reaches the model. No I/O here, so every rule is testable
// (see test/engine.test.ts). Scoring is not here: the caller scores candidates
// on the 0 to 3 relevance scale below and passes them to select().

import { shape } from "./shapers.ts";

export type Candidate = { id: string; text: string; source: string };

/**
 * A candidate after cleanup (cleanCandidate): `cleaned` lists the noise removed, and
 * `originalTokens` is its size as received, which savings are measured against.
 */
export type Cleaned = Candidate & { originalTokens?: number; cleaned?: string[] };

/** A candidate after scoring. `score` is the expected relevance on a 0 to 3 scale. */
export type Scored = Cleaned & { tokens: number; score: number };

/** `restored` only appears in older logs, from when the quality guard re-added items. */
export type Reason = "relevant" | "restored" | "low_relevance" | "duplicate" | "over_budget";
/** `reused`: the decision was recalled from earlier in the same conversation (conversation.ts), not made now. */
export type Decision = Scored & { kept: boolean; reason: Reason; duplicateOf?: string; reused?: boolean };

export type Aggressiveness = "conservative" | "balanced" | "aggressive";

/**
 * Items scoring below this expected relevance are dropped. The scale:
 * 0 unrelated or only sharing surface words · 1 loosely related background, not
 * needed · 2 useful supporting evidence · 3 directly answers or is essential.
 */
export const KEEP_THRESHOLD: Record<Aggressiveness, number> = {
  conservative: 0.9,
  balanced: 1.4,
  aggressive: 1.9,
};

/**
 * The relevance threshold select() applies: the aggressiveness base plus a learned
 * offset (the hosted service learns one per agent), kept inside the 0 to 3 scale so it can neither keep
 * pure noise nor drop items the scorer rated essential.
 */
export function keepThreshold(aggressiveness: Aggressiveness, offset = 0): number {
  // Rounded: the offset builds up from repeated float additions, and the threshold is logged and shown.
  return Math.round(Math.min(2.7, Math.max(0.3, KEEP_THRESHOLD[aggressiveness] + offset)) * 100) / 100;
}

export const LIMITS = { candidates: 500, charsPerCandidate: 60_000, queryChars: 8_000, minBudget: 200, maxBudget: 200_000 };

export class InputError extends Error {}

/** Agent names become Mongo field names, so keep them to a safe charset. */
export function agentKey(name: unknown): string {
  // Accents are dropped, not replaced: "Géni Général" is "geni-general", not "g-ni-g-n-ral".
  const s = typeof name === "string" ? name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) : "";
  return s || "default";
}

// chars/4 approximation. Swap for a real tokenizer if exact counts are needed.
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Accepts the loose shapes callers send (plain strings or objects) and returns
 * candidates with stable ids and a source label. Throws InputError on bad input.
 */
export function normalizeCandidates(input: unknown): Candidate[] {
  if (!Array.isArray(input) || input.length === 0) throw new InputError("`candidates` must be a non-empty array.");
  if (input.length > LIMITS.candidates) throw new InputError(`At most ${LIMITS.candidates} candidates per request.`);
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const obj = typeof raw === "string" ? { text: raw } : (raw as Record<string, unknown>);
    const text = typeof obj?.text === "string" ? obj.text.trim() : "";
    if (!text) throw new InputError(`candidates[${i}] needs a non-empty \`text\`.`);
    if (text.length > LIMITS.charsPerCandidate) throw new InputError(`candidates[${i}] exceeds ${LIMITS.charsPerCandidate} characters.`);
    let id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim().slice(0, 80) : `c${i}`;
    if (seen.has(id)) id = `${id}#${i}`;
    seen.add(id);
    // Sources become Mongo field names in request logs, so keep them to a safe charset.
    const source = typeof obj.source === "string" ? obj.source.trim().toLowerCase().replace(/[^a-z0-9_ -]+/g, "-").slice(0, 40) || "context" : "context";
    return { id, text, source };
  });
}

/**
 * Removes noise from structured candidates with the shapers the SDK also uses
 * (shapers.ts): terminal codes and progress bars, passing tests, repeated log
 * lines, empty JSON fields, HTML markup, long file listings. Plain text, such as most
 * RAG chunks, is never changed. Deterministic, so a candidate sent again in a
 * conversation comes out byte-identical.
 */
export function cleanCandidate(c: Candidate): Cleaned {
  const originalTokens = estimateTokens(c.text);
  const s = shape(c.text);
  if (s.kind === "text" || !s.notes.length || s.text.length >= c.text.length) return { ...c, originalTokens };
  return { ...c, text: s.text, originalTokens, cleaned: s.notes };
}

function shingles(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 <= words.length; i++) out.add(words[i] + " " + words[i + 1]);
  if (out.size === 0 && words.length) out.add(words.join(" "));
  return out;
}

/**
 * Near-duplicate test on word pairs. Containment (shared / smaller set) rather than
 * Jaccard, so a trimmed copy of a chunk still counts. Calibrated on the playground
 * examples: paraphrased duplicates score 0.67 to 0.86, unrelated chunks under 0.2.
 */
const DUPLICATE_CONTAINMENT = 0.6;
const MIN_PAIRS_FOR_FUZZY = 4;

function isDuplicate(a: Set<string>, b: Set<string>): boolean {
  const small = a.size <= b.size ? a : b;
  const large = small === a ? b : a;
  let shared = 0;
  for (const s of small) if (large.has(s)) shared++;
  if (small.size < MIN_PAIRS_FOR_FUZZY) return shared === small.size && small.size === large.size;
  return shared / small.size >= DUPLICATE_CONTAINMENT;
}

/**
 * Keeps relevant, non-duplicate items that fit the budget, choosing strongest first.
 * Returns every candidate with a decision, in the caller's order: the kept items are
 * sent in the order the caller gave them, never re-ranked, so a conversation's
 * history reads the same on every turn (see conversation.ts).
 * `alreadySent`: items kept earlier in the conversation; new items that duplicate
 * them are dropped, and they don't count against the budget.
 */
export function select(scored: Scored[], budget: number, threshold: number, alreadySent: Candidate[] = []): Decision[] {
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const decided = new Map<string, Decision>();
  const keptShingles = alreadySent.map((c) => ({ id: c.id, sh: shingles(c.text) }));
  let used = 0;

  // O(n²) duplicate scan over kept items; fine for the 500-candidate cap.
  for (const item of ranked) {
    if (item.score < threshold) { decided.set(item.id, { ...item, kept: false, reason: "low_relevance" }); continue; }
    const sh = shingles(item.text);
    const dup = keptShingles.find((k) => isDuplicate(sh, k.sh));
    if (dup) { decided.set(item.id, { ...item, kept: false, reason: "duplicate", duplicateOf: dup.id }); continue; }
    if (used + item.tokens > budget) { decided.set(item.id, { ...item, kept: false, reason: "over_budget" }); continue; }
    used += item.tokens;
    decided.set(item.id, { ...item, kept: true, reason: "relevant" });
    keptShingles.push({ id: item.id, sh });
  }
  return scored.map((s) => decided.get(s.id)!);
}

export function sumTokens(items: { tokens: number }[]): number {
  return items.reduce((n, i) => n + i.tokens, 0);
}
