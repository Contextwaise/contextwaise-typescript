// Cache-safe mode: within a conversation, a decision is made once and never changes.
//
// LLM APIs are stateless: every turn resends the whole conversation, and the
// provider's prompt cache only bills the repeated start cheaply (~0.05-0.1x) while
// it is byte-identical. If an item sent at turn 3 were re-scored at turn 4 against
// a new query, it could flip from kept to dropped: the conversation's start would
// change, the cache would miss, and on newer Claude models (preserved thinking)
// edited history is rejected with a 400. So when the caller names a conversation,
// every item's decision is stored under a fingerprint of its text, and an item that
// comes back gets its stored decision instead of a new one (and costs no scoring).
// Only the fingerprint is stored, never the text.
//
// A routed model is decided once per conversation for the same reason: switching
// models mid-conversation loses the provider's cache and, on newer Claude models,
// the reasoning so far. It is stored alongside the item decisions, as an opaque value.
//
// Decisions live in a DecisionStore, one hash per conversation. The week-long TTL
// outlives any provider cache on purpose: the preserved-thinking check never expires.

import { InputError, type Candidate, type Decision, type Reason } from "./engine.ts";

/** Where conversation decisions live: a hash of string fields per key with an expiry, such as Redis. */
export interface DecisionStore {
  /** The values of `fields` in the hash at `key` (null for a missing field), or null when the store can't be reached. */
  readFields(key: string, fields: string[]): Promise<(string | null)[] | null>;
  /** Writes the fields into the hash at `key` and resets its expiry. Returns false when the store can't be reached. */
  writeFields(key: string, entries: Record<string, string>, ttlSeconds: number): Promise<boolean>;
}

const MEMORY_TTL_SECONDS = 7 * 24 * 3600;

/** What is stored per item. `duplicateOf` is not: ids can differ between requests. */
export type Remembered = { kept: boolean; reason: Reason; score: number };

const conversationKey = (projectId: string, conversation: string) => `cw:conv:${projectId}:${conversation}`;
// Fingerprints are 22-char base64url, so this field name can't collide with one.
const ROUTE_FIELD = "route";

/** SHA-256 of the text, base64url, first 22 chars. Web Crypto, so it runs in Node, browsers and edge runtimes alike. */
async function fingerprint(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").slice(0, 22);
}

/**
 * What this conversation already decided: the candidates' stored decisions by
 * candidate id, and the routed model. One store read. `available` is false when
 * the store can't be reached: nothing is known, so everything is decided anew and
 * the conversation is not protected for this request.
 */
export async function recallConversation<Route>(store: DecisionStore, projectId: string, conversation: string, candidates: Candidate[]): Promise<{ remembered: Map<string, Remembered>; route: Route | null; available: boolean }> {
  const fingerprints = await Promise.all(candidates.map((c) => fingerprint(c.text)));
  const values = await store.readFields(conversationKey(projectId, conversation), [ROUTE_FIELD, ...fingerprints]);
  const remembered = new Map<string, Remembered>();
  values?.slice(1).forEach((raw, i) => {
    if (raw) remembered.set(candidates[i].id, JSON.parse(raw) as Remembered);
  });
  return { remembered, route: values?.[0] ? (JSON.parse(values[0]) as Route) : null, available: values !== null };
}

/** Stores the decisions (and the route, when newly decided) and keeps the conversation alive for another week. */
export async function rememberConversation<Route>(store: DecisionStore, projectId: string, conversation: string, decisions: Decision[], route?: Route): Promise<boolean> {
  const entries = Object.fromEntries(await Promise.all(decisions.map(async (d) => [await fingerprint(d.text), JSON.stringify({ kept: d.kept, reason: d.reason, score: d.score } satisfies Remembered)] as const)));
  if (route) entries[ROUTE_FIELD] = JSON.stringify(route);
  return store.writeFields(conversationKey(projectId, conversation), entries, MEMORY_TTL_SECONDS);
}

/** The caller's conversation id (1 to 128 chars of letters, digits and `_ - . :`), or null when absent. Throws InputError otherwise. */
export function conversationId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && /^[\w.:-]{1,128}$/.test(value)) return value;
  throw new InputError("`conversation` must be 1 to 128 characters: letters, digits, `_`, `-`, `.` or `:`.");
}
