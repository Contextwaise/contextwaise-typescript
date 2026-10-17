// Free, deterministic clean-up of tool output, by content type. No model, no
// network: the same input always gives the same output, which keeps the model's
// view of a result stable (prompt caching) even when it is rebuilt later.
//
// shape() removes what is noise for any reader (color codes, progress bars,
// passing tests, repeated log lines, empty JSON fields, HTML markup).
// sections() then cuts the cleaned text into units that relevance scoring keeps
// or drops (core.ts). Errors are never removed here.

/** `lines`: rows without paragraphs (CSV, query results, schema dumps, tables), cut one line at a time. */
export type Kind = "json" | "html" | "test" | "listing" | "log" | "lines" | "text";

export type Shaped = { kind: Kind; text: string; notes: string[] };

/** Rough token count, chars/4, the same estimate the Contextwaise API uses. */
export const tokens = (text: string) => Math.ceil(text.length / 4);

const ERROR_LINE = /\b(error|fail(ed|ure)?|exception|traceback|panic|fatal|denied|refused|timeout|cannot|undefined is not)\b|✗|✕/i;

/** Whether a line reports a problem: such lines are always kept. */
export const isErrorLine = (line: string) => ERROR_LINE.test(line);

export function shape(raw: string): Shaped {
  const notes: string[] = [];
  let text = stripTerminalNoise(raw, notes);
  const kind = detect(text);
  if (kind === "json") text = shapeJson(text, notes);
  else if (kind === "html") text = shapeHtml(text, notes);
  else if (kind === "test") text = shapeTests(text, notes);
  else if (kind === "listing") text = shapeListing(text, notes);
  else if (kind === "log") text = collapseRepeats(text, notes);
  return { kind, text, notes };
}

/** Cuts shaped text into the units relevance is judged on. */
export function sections(kind: Kind, text: string): string[] {
  if (kind === "json") {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return value.map((v) => JSON.stringify(v));
    // API envelopes ({ meta, orders: [...] }) put the data in an array under one key:
    // each item becomes its own unit (keyed `orders[3]`), or the whole array would be one part.
    if (value && typeof value === "object")
      return Object.entries(value).flatMap(([k, v]) => (Array.isArray(v) && v.length > 1 ? v.map((item, i) => JSON.stringify({ [`${k}[${i}]`]: item })) : [JSON.stringify({ [k]: v })]));
  }
  if (kind === "listing" || kind === "log" || kind === "lines") return text.split("\n").filter((l) => l.trim()); // listing: one directory per line
  if (kind === "test") return text.split(/\n(?=\S)/).filter((b) => b.trim()); // one block per unindented line
  return text.split(/\n\s*\n/).filter((p) => p.trim()); // paragraphs
}

// ---- detection ----

function detect(text: string): Kind {
  const t = text.trim();
  if ((t.startsWith("{") || t.startsWith("[")) && isJson(t)) return "json";
  if (/<(html|body|div|p|head|article)[\s>]/i.test(t)) return "html";
  if (/\b(\d+ (passing|passed|failing|failed)|Tests?:\s+\d+|PASS |FAIL )/.test(t)) return "test";
  const lines = t.split("\n").filter((l) => l.trim());
  if (lines.length < 15) return "text";
  if (lines.filter((l) => /^[\w@.\-/]+(\/[\w@.\-]+)+\/?$/.test(l.trim())).length / lines.length > 0.7) return "listing";
  // Before logs: a CSV whose rows start with a date is data, and the log shaper
  // would collapse its rows, which differ only by numbers, into one.
  if (isTable(lines)) return "lines";
  if (lines.filter((l) => /^\[?\d{4}-\d{2}-\d{2}|^\[?\d{2}:\d{2}:\d{2}|\b(INFO|WARN|ERROR|DEBUG)\b/.test(l)).length / lines.length > 0.5) return "log";
  // No paragraphs to cut on (a schema dump, kubectl output): cut by line, or the
  // whole output is one part, kept or dropped as one.
  if (Math.max(...t.split(/\n\s*\n/).map((p) => p.split("\n").length)) >= 0.8 * lines.length) return "lines";
  return "text";
}

/** Rows with the same number of a delimiter (CSV, TSV, pipe tables) as the first. */
function isTable(lines: string[]): boolean {
  return [",", "\t", "|"].some((d) => {
    const count = lines[0].split(d).length - 1;
    return count > 0 && lines.filter((l) => l.split(d).length - 1 === count).length / lines.length > 0.9;
  });
}

function isJson(t: string) {
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

// ---- shapers ----

function stripTerminalNoise(raw: string, notes: string[]): string {
  // eslint-disable-next-line no-control-regex
  const plain = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  // A carriage return redraws the line: only its last state was ever visible.
  // Trailing ones are line endings (CRLF), not redraws.
  const lines = plain.split("\n").map((l) => l.replace(/\r+$/, "").split("\r").at(-1)!);
  const kept = lines.filter((l) => !/^\s*[[(]?[=#>.\-\s]{8,}[\])]?\s*\d{1,3}%/.test(l));
  const removed = lines.length - kept.length;
  if (removed) notes.push(`removed ${removed} progress-bar lines`);
  if (plain.length < raw.length) notes.push("removed terminal color codes");
  return kept.join("\n").trim();
}

function shapeJson(text: string, notes: string[]): string {
  let dropped = 0;
  const prune = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(prune);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (val === null || val === "" || (Array.isArray(val) && !val.length) || (typeof val === "object" && val && !Object.keys(val).length)) {
          dropped++;
          continue;
        }
        out[k] = prune(val);
      }
      return out;
    }
    return v;
  };
  const parsed = JSON.parse(text);
  const value = prune(parsed);
  if (dropped) notes.push(`dropped ${dropped} empty JSON fields`);
  // Pretty-printed or spaced JSON: the compact form is the same data in fewer tokens.
  if (JSON.stringify(parsed).length < text.length) notes.push("compacted JSON whitespace");
  return JSON.stringify(value);
}

function shapeHtml(text: string, notes: string[]): string {
  const out = text
    .replace(/<(script|style|nav|footer|header|aside|noscript|svg)[\s\S]*?<\/\1>/gi, "")
    // Cookie and consent banners: matched by class or id (no nesting inside them assumed).
    .replace(/<(div|section)[^>]*\b(?:class|id)="[^"]*(?:cookie|consent)[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/title|\/article|\/section)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*(\n\s*)+/g, "\n\n")
    .trim();
  notes.push("converted HTML to text (scripts, styles, navigation, banners and footer removed)");
  return out;
}

function shapeTests(text: string, notes: string[]): string {
  const lines = text.split("\n");
  const passing = (l: string) => /^\s*(✓|✔|√|PASS\b|ok \d)/.test(l) && !isErrorLine(l);
  const kept = lines.filter((l) => !passing(l));
  const dropped = lines.length - kept.length;
  if (dropped) notes.push(`removed ${dropped} passing-test lines (summary kept)`);
  return kept.join("\n");
}

/**
 * A file listing, one line per directory, numbered series collapsed:
 *   src/admin/components/  Widget{0..29}.tsx
 *   src/auth/  middleware.ts, session.test.ts, session.ts
 * Nothing is lost (every path can be rebuilt), and the model sees the whole shape of
 * the tree at once instead of a slice of it.
 */
function shapeListing(text: string, notes: string[]): string {
  const dirs = new Map<string, string[]>();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const path of lines) {
    const cut = path.lastIndexOf("/");
    const dir = cut < 0 ? "" : path.slice(0, cut + 1);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push(path.slice(cut + 1));
  }
  const out = [...dirs].map(([dir, files]) => `${dir || "./"}  ${collapseSeries(files).join(", ")}`);
  notes.push(`grouped ${lines.length} paths into ${out.length} directory lines`);
  return out.join("\n");
}

/** ["Widget0.tsx", …, "Widget29.tsx"] → ["Widget{0..29}.tsx"]; non-contiguous numbers stay listed. */
function collapseSeries(files: string[]): string[] {
  const series = new Map<string, number[]>();
  const plain: string[] = [];
  for (const f of files) {
    // The number is the last one in the name, without leading zeros: "img007.png" is
    // "img00" + 7, so a series never loses its padding.
    const m = f.match(/^(.*?)(0|[1-9]\d*)(\D*)$/);
    if (!m) plain.push(f);
    else {
      const key = `${m[1]}\u0000${m[3]}`;
      if (!series.has(key)) series.set(key, []);
      series.get(key)!.push(Number(m[2]));
    }
  }
  const out = [...plain];
  for (const [key, nums] of series) {
    const [pre, post] = key.split("\u0000");
    nums.sort((a, b) => a - b);
    const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
    if (nums.length >= 3 && contiguous) out.push(`${pre}{${nums[0]}..${nums.at(-1)}}${post}`);
    else out.push(...nums.map((n) => `${pre}${n}${post}`));
  }
  return out;
}

function collapseRepeats(text: string, notes: string[]): string {
  // Lines that differ only by numbers (timestamps, ids, durations) are repeats.
  const norm = (l: string) => l.replace(/\d+/g, "#");
  const out: string[] = [];
  let collapsed = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && norm(lines[j + 1]) === norm(lines[i]) && !isErrorLine(lines[i])) j++;
    // The count goes on the same line: a separate "repeated … times" line would be
    // a section of its own, matched by any question about "timestamps".
    out.push(j > i ? `${lines[i]}  (×${j - i + 1})` : lines[i]);
    if (j > i) {
      collapsed += j - i;
      i = j;
    }
  }
  if (collapsed) notes.push(`collapsed ${collapsed} repeated log lines`);
  return out.join("\n");
}
