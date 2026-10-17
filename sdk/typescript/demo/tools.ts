// Demo tools with realistic, deliberately noisy outputs (fake data, generated
// deterministically): a repo listing, source files, a test run, application logs,
// an orders API and a docs page. Each is a normal Vercel AI SDK tool.

import { jsonSchema, tool } from "ai";

// ---- fake repository ----

const FEATURES = ["billing", "catalog", "cart", "search", "profile", "inventory", "shipping", "reviews", "notifications", "reports", "admin", "analytics"];
const FILES = ["index.ts", "service.ts", "routes.ts", "schema.ts", "utils.ts", "service.test.ts", "README.md"];

export const REPO_PATHS = [
  ...FEATURES.flatMap((f) => FILES.map((file) => `src/${f}/${file}`)),
  ...FEATURES.flatMap((f) => Array.from({ length: 30 }, (_, i) => `src/${f}/components/Widget${i}.tsx`)),
  "src/auth/middleware.ts",
  "src/auth/session.ts",
  "src/auth/session.test.ts",
  "src/checkout/discount.ts",
  "src/checkout/discount.test.ts",
  "src/checkout/index.ts",
  "docs/architecture.md",
  "package.json",
  "tsconfig.json",
].sort();

const SOURCES: Record<string, string> = {
  "src/auth/middleware.ts": `import { verifySession } from "./session";

/** Rejects requests without a valid session cookie; attaches the user otherwise. */
export async function authMiddleware(req: Request, next: () => Promise<Response>) {
  const token = req.headers.get("cookie")?.match(/sid=([^;]+)/)?.[1];
  if (!token) return new Response("Unauthorized", { status: 401 });
  const user = await verifySession(token);
  if (!user) return new Response("Session expired", { status: 401 });
  (req as Request & { user?: unknown }).user = user;
  return next();
}
`,
  "src/checkout/discount.test.ts": `import { describe, expect, it } from "vitest";
import { applyDiscount } from "./discount";

describe("applyDiscount", () => {
  it("applies a coupon", () => {
    expect(applyDiscount({ subtotal: 100, coupon: "WELCOME10" }, false)).toBe(90);
  });
  it("applies loyalty discount after coupon", () => {
    // 100 - 10% coupon = 90, then -10% loyalty on 90 = 81... but the spec says loyalty is 20% for VIP coupons
    expect(applyDiscount({ subtotal: 100, coupon: "VIP20" }, true)).toBe(72);
  });
});
`,
  "src/auth/session.ts": `const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map<string, { userId: string; lastSeen: number }>();

/** Returns the user for a valid session token, refreshing its expiry; null when unknown or expired. */
export async function verifySession(token: string) {
  const s = sessions.get(token);
  if (!s) return null;
  // BUG: compares against creation time units in seconds, so sessions never expire.
  if (Date.now() / 1000 - s.lastSeen > SESSION_TTL_MS) return null;
  s.lastSeen = Date.now();
  return { id: s.userId };
}
`,
  "src/auth/session.test.ts": `import { expect, it, vi } from "vitest";
import { verifySession } from "./session";

it("expires sessions after 30 minutes", async () => {
  vi.useFakeTimers();
  // create a session, then move the clock 31 minutes forward
  vi.advanceTimersByTime(31 * 60 * 1000);
  expect(await verifySession("expired-token")).toBeNull();
});
`,
  "src/billing/service.ts": `import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_KEY!, { timeout: 30_000, maxNetworkRetries: 0 });

/** Charges a confirmed order. Throws PaymentTimeout when Stripe doesn't answer in 30 s. */
export class PaymentClient {
  async charge(orderId: string, amountCents: number) {
    try {
      return await stripe.paymentIntents.create({ amount: amountCents, currency: "eur", metadata: { orderId } });
    } catch (e) {
      // No retries: a timeout here surfaces as "payment-gateway timeout" in the logs (line 88 in production build).
      throw e;
    }
  }
}
`,
  "src/checkout/discount.ts": `export type Cart = { subtotal: number; coupon?: string };

const COUPONS: Record<string, number> = { WELCOME10: 0.1, VIP20: 0.2 };

/** Applies the coupon, then the 10% loyalty discount for members. */
export function applyDiscount(cart: Cart, member: boolean): number {
  let total = cart.subtotal;
  const rate = cart.coupon ? COUPONS[cart.coupon] ?? 0 : 0;
  total = total - total * rate;
  if (member) {
    // BUG: the loyalty discount is applied to the subtotal, not the discounted total.
    total = total - cart.subtotal * 0.1;
  }
  return Math.round(total * 100) / 100;
}
`,
};

const genericSource = (path: string) =>
  Array.from({ length: 120 }, (_, i) => (i % 12 === 0 ? `// ${path} — section ${i / 12}` : `export const value${i} = compute(${i}, "${path}");`)).join("\n");

// ---- fake outputs ----

// Dated in the current month, so "this month" and "today" questions make sense.
const NOW = new Date();
const MONTH = `${NOW.getUTCFullYear()}-${String(NOW.getUTCMonth() + 1).padStart(2, "0")}`;
const TODAY = `${MONTH}-${String(NOW.getUTCDate()).padStart(2, "0")}`;

const ANSI = (code: number, s: string) => `\x1b[${code}m${s}\x1b[0m`;

function testRun(): string {
  const lines = ["\x1b[2J RUN  v3.2.4 /workspace/shop", ...Array.from({ length: 6 }, (_, i) => `[${"=".repeat(i * 4).padEnd(24)}] ${Math.round((i / 5) * 100)}%`)];
  for (const f of [...FEATURES, "auth", "checkout"]) {
    for (let i = 0; i < 24; i++) lines.push(ANSI(32, `  ✓ src/${f}/service.test.ts > ${f} case ${i} works as expected (${(i * 7) % 40}ms)`));
  }
  lines.push(
    ANSI(31, "  ✗ src/checkout/discount.test.ts > applies loyalty discount after coupon"),
    "    AssertionError: expected 81 to be 72",
    "     ❯ applyDiscount src/checkout/discount.ts:12:13",
    "     ❯ src/checkout/discount.test.ts:18:32",
    ANSI(31, "  ✗ src/auth/session.test.ts > expires sessions after 30 minutes"),
    "    AssertionError: expected session to be null",
    "     ❯ verifySession src/auth/session.ts:41:9",
    "",
    " Test Files  2 failed | 13 passed (15)",
    "      Tests  2 failed | 336 passed (338)",
    "   Duration  4.81s",
  );
  return lines.join("\n");
}

function appLogs(): string {
  const lines: string[] = [];
  for (let i = 0; i < 1800; i++) {
    const t = `${TODAY} ${String(8 + Math.floor(i / 180)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:${String((i * 13) % 60).padStart(2, "0")}`;
    if (i % 3 === 0) lines.push(`${t} INFO  heartbeat ok workers=8 queue=0`);
    else if (i === 910 || i === 1406) {
      lines.push(
        `${t} ERROR payment-gateway timeout after 30000ms order=ord_${4000 + i} provider=stripe`,
        `    at PaymentClient.charge (src/billing/service.ts:88:15)`,
        `    at async Checkout.complete (src/checkout/index.ts:54:9)`,
        `    cause: ETIMEDOUT connect 10.0.4.12:443`,
      );
    } else if (i % 97 === 0) lines.push(`${t} WARN  slow query 1.${i % 9}s table=orders`);
    else lines.push(`${t} INFO  GET /api/catalog/items?page=${i % 40} 200 ${(i * 3) % 90}ms`);
  }
  return lines.join("\n");
}

function orders(customer: string) {
  return Array.from({ length: 36 }, (_, i) => ({
    id: `ord_${9100 + i}`,
    customer,
    status: i % 9 === 0 ? "refunded" : "paid",
    total: Math.round((40 + ((i * 37) % 260)) * 100) / 100,
    currency: "EUR",
    createdAt: `${MONTH}-${String(1 + (i % NOW.getUTCDate())).padStart(2, "0")}T${String(8 + (i % 10)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:00Z`,
    items: [{ sku: `SKU-${100 + (i % 17)}`, qty: 1 + (i % 3) }],
    giftMessage: null,
    couponCode: "",
    internalNotes: [],
    metadata: {},
    shippingTracking: null,
    legacyId: null,
  }));
}

function docsPage(): string {
  return `<html><head><title>API limits</title><style>body{font-family:sans-serif}</style><script>window.analytics=1</script></head>
<body><nav><a href="/">Home</a> <a href="/guides">Guides</a> <a href="/api">API</a> <a href="/pricing">Pricing</a> <a href="/blog">Blog</a></nav>
<header><h1>Example Docs</h1><p>Search the docs…</p></header>
<article>
<h2>Authentication</h2><p>Every request needs an API key in the Authorization header. Keys are created in the dashboard and can be revoked at any time.</p>
<h2>Pagination</h2><p>List endpoints return 50 items per page. Use the cursor field to fetch the next page.</p>
<h2>Rate limits</h2><p>Each API key can make 600 requests per minute. Configure a different limit per key in Settings &gt; API keys &gt; Rate limit. When you exceed it the API returns 429 with a Retry-After header.</p>
<h2>Errors</h2><p>Errors return a JSON body with code and message fields.</p>
<h2>Webhooks</h2><p>Webhooks retry for 3 days with exponential backoff.</p>
</article>
<footer><p>© 2026 Example Inc. · Privacy · Terms · Status · Careers · Contact</p></footer>
<script>loadChatWidget(); trackPage();</script></body></html>`;
}

// ---- the tools ----

const schema = <T>(properties: Record<string, { type: "string" }>, required: string[] = []) =>
  jsonSchema<T>({ type: "object", properties, required, additionalProperties: false });

export const demoTools = {
  list_files: tool({
    description: "List every file in the repository under a directory, recursively.",
    inputSchema: schema<{ dir: string }>({ dir: { type: "string" } }, ["dir"]),
    execute: async ({ dir }) => REPO_PATHS.filter((p) => dir === "." || p.startsWith(dir)).join("\n"),
  }),
  read_file: tool({
    description: "Read a source file.",
    inputSchema: schema<{ path: string }>({ path: { type: "string" } }, ["path"]),
    execute: async ({ path }) => SOURCES[path] ?? genericSource(path),
  }),
  run_tests: tool({
    description: "Run the test suite and return its output.",
    inputSchema: schema<Record<string, never>>({}),
    execute: async () => testRun(),
  }),
  search_logs: tool({
    description: "Return today's application logs matching a query.",
    inputSchema: schema<{ query: string }>({ query: { type: "string" } }, ["query"]),
    execute: async () => appLogs(),
  }),
  get_orders: tool({
    description: "List a customer's orders from the orders API (JSON).",
    inputSchema: schema<{ customer: string }>({ customer: { type: "string" } }, ["customer"]),
    execute: async ({ customer }) => orders(customer),
  }),
  fetch_docs: tool({
    description: "Fetch a documentation page (HTML).",
    inputSchema: schema<{ url: string }>({ url: { type: "string" } }, ["url"]),
    execute: async () => docsPage(),
  }),
};
