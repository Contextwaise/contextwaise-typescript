// Synthetic tool outputs with planted facts, the same data as the app repo's gauntlet and
// the Python e2e (fixtures.py in the Python SDK's e2e), so answers can be checked exactly.

export const NEEDLES = { orderId: "ORD-1337", orderStatus: "lost_in_transit", orderCarrier: "Polar Express Freight", errorCode: "E-4242", lateFee: "7.5" };

const STATUSES = ["delivered", "shipped", "processing", "delivered", "cancelled"];
export function orders(customer: string) {
  return {
    customer, page: 1, total: 180, next: null, warnings: [], meta: { region: "eu-west-1", cache: null, debug: {} },
    orders: Array.from({ length: 180 }, (_, i) => ({
      id: i === 117 ? NEEDLES.orderId : `ORD-${1000 + i}`,
      status: i === 117 ? NEEDLES.orderStatus : STATUSES[i % 5],
      carrier: i === 117 ? NEEDLES.orderCarrier : ["DHL", "UPS", "Colissimo"][i % 3],
      total: { amount: 20 + ((i * 37) % 300), currency: "EUR" },
      items: [{ sku: `SKU-${(i * 13) % 500}`, qty: 1 + (i % 3) }],
      coupon: i % 7 === 0 ? "WELCOME10" : null, giftMessage: "", notes: null, tags: [], returnLabel: null, metadata: {},
    })),
  };
}

export function appLogs(count = 1600) {
  return Array.from({ length: count }, (_, i) => {
    const t = `2026-10-11T09:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
    if (i === Math.floor(count * 0.77)) return `${t} ERROR payments ${NEEDLES.errorCode} payment-gateway timeout after 30000ms (order ${NEEDLES.orderId}, retries=0)`;
    if (i % 50 === 0) return `${t} WARN  cache miss ratio above 0.4 for catalog`;
    return `${t} INFO  http GET /api/catalog 200 ${12 + (i % 9)}ms`;
  }).join("\n");
}

export function testRun() {
  const out = ["\x1b[1m> vitest run\x1b[0m", ""];
  for (const s of ["cart", "catalog", "checkout", "search", "session", "profile", "inventory", "shipping"]) {
    out.push(` ${s}.test.ts`);
    for (let i = 0; i < 40; i++) {
      if (s === "checkout" && i === 12) out.push("   \x1b[31m✗ applies VIP20 coupon to discounted total\x1b[0m\n     AssertionError: expected 72 to equal 81\n       at checkout.test.ts:88:14");
      else if (s === "session" && i === 30) out.push("   \x1b[31m✗ expires idle sessions after 30 minutes\x1b[0m\n     AssertionError: expected session to be expired\n       at session.test.ts:41:9");
      else out.push(`   \x1b[32m✓\x1b[0m ${s} case ${i} behaves (${i % 5}ms)`);
    }
  }
  out.push("", " Test Files  2 failed | 6 passed (8)", "      Tests  2 failed | 318 passed (320)");
  return out.join("\n");
}

const DIRS = ["billing", "cart", "catalog", "search", "profile", "inventory", "shipping", "reviews", "admin", "analytics"];
export const REPO_PATHS = DIRS.flatMap((d) => ["index.ts", "service.ts", "routes.ts", "schema.ts", "utils.ts", "service.test.ts", ...Array.from({ length: 30 }, (_, i) => `handlers/h${i}.ts`)].map((f) => `src/${d}/${f}`)).concat("src/billing/rates.ts");

export function readFile(path: string) {
  const lines = Array.from({ length: 150 }, (_, i) => (i % 15 === 0 ? `// ${path} — section ${i / 15}` : `export const value${i} = compute(${i}, "${path}");`));
  if (path === "src/billing/rates.ts") lines.splice(97, 0, "/** Late payment fee, percent of the invoice total, applied after 30 days. */", `export const LATE_FEE_PERCENT = ${NEEDLES.lateFee};`);
  return lines.join("\n");
}
