// The Contextwaise API, seen from the SDK: relevance scoring (Jev, with the API's
// key, never shipped in the SDK) and usage reports for the dashboard.
//
// Neither may ever slow down or break the agent:
// - scoring has a short timeout; after a failure the API is skipped for a while and
//   the model gets the cleaned output whole instead (nothing cut);
// - reports are batched, sent in the background, and dropped if they can't be sent.
//   They carry sizes, tool names and the model id only, never tool output.

export type ResultReport = {
  type: "result";
  callId: string;
  tool: string;
  /** Groups the result on the dashboard; the app's default agent when absent. */
  agent?: string;
  integration: string;
  /** The model id that reads the result, when the adapter knows it. */
  model?: string;
  kind: string;
  mode: "full" | "shaped" | "trimmed";
  /** Why the result got its view (Reason in core.ts). */
  reason: string;
  scorer: "jev" | "none";
  tokensBefore: number;
  tokensAfter: number;
  ms: number;
};
/** `contextTokens`: input tokens of the model call that asked for the expand, when known. */
export type ExpandReport = { type: "expand"; callId: string; tool: string; agent?: string; tokens: number; contextTokens?: number };
export type Report = ResultReport | ExpandReport;

export type Backend = {
  /** Relevance of each section (0 to 1) for the intent, or null when the API is unavailable. */
  score(input: { callId: string; tool: string; agent?: string; intent: string; sections: string[] }): Promise<number[] | null>;
  /** Queues a usage report. Never throws, never waits. */
  report(item: Report): void;
  /** Sends queued reports now. Call before a short-lived process exits. */
  flush(): Promise<void>;
};

const SCORE_TIMEOUT_MS = 4000;
const PAUSE_AFTER_FAILURE_MS = 30_000;
// The free tokens are used up: only an upgrade brings scoring back, so retrying every 30s is pointless.
const PAUSE_AFTER_QUOTA_MS = 3600_000;
const REPORT_BATCH = 50;
const REPORT_DELAY_MS = 2000;
const MAX_QUEUE = 1000;

export function connectBackend(opts: { apiKey: string; baseUrl: string; onError: (message: string) => void }): Backend {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" };
  let pausedUntil = 0;
  let queue: Report[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function score(input: { callId: string; tool: string; agent?: string; intent: string; sections: string[] }): Promise<number[] | null> {
    if (Date.now() < pausedUntil) return null;
    try {
      const res = await fetch(`${base}/api/v1/tool-results`, {
        method: "POST",
        headers,
        // The API rejects an intent over 4,000 chars (LIMITS.intentChars), e.g. when a tool's arguments carry a whole file.
        body: JSON.stringify({ ...input, intent: input.intent.slice(0, 4000) }),
        signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
      });
      // A request the API rejects (too big, malformed) is this call's problem: the next one may score fine.
      if ([400, 413, 422].includes(res.status)) {
        opts.onError(`relevance API rejected this result, passed whole: HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
        return null;
      }
      if (res.status === 429) {
        const text = await res.text();
        if (text.includes("quota_exceeded")) {
          pausedUntil = Date.now() + PAUSE_AFTER_QUOTA_MS;
          opts.onError(`free Contextwaise tokens used up: passing cleaned outputs whole for an hour (upgrade in Billing): ${text.slice(0, 160)}`);
          return null;
        }
        throw new Error(`HTTP 429: ${text.slice(0, 160)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const body = (await res.json()) as { scores?: number[] };
      if (body.scores?.length !== input.sections.length) throw new Error("the API returned a score per section count that doesn't match");
      return body.scores;
    } catch (e) {
      pausedUntil = Date.now() + PAUSE_AFTER_FAILURE_MS;
      opts.onError(`relevance API unavailable, passing cleaned outputs whole for ${PAUSE_AFTER_FAILURE_MS / 1000}s: ${(e as Error).message}`);
      return null;
    }
  }

  function report(item: Report) {
    if (queue.length >= MAX_QUEUE) queue.shift(); // the API is unreachable for long: keep the newest
    queue.push(item);
    if (queue.length >= REPORT_BATCH) void flush();
    else if (!timer) {
      timer = setTimeout(() => void flush(), REPORT_DELAY_MS);
      (timer as { unref?: () => void }).unref?.(); // never keep a process alive just to report
    }
  }

  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    while (queue.length) {
      const batch = queue.slice(0, REPORT_BATCH);
      queue = queue.slice(REPORT_BATCH);
      try {
        const res = await fetch(`${base}/api/v1/tool-results/report`, {
          method: "POST",
          headers,
          body: JSON.stringify({ results: batch }),
          signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        opts.onError(`usage report dropped (${batch.length} results): ${(e as Error).message}`);
      }
    }
  }

  return { score, report, flush };
}
