// Live view of the demo agent: listens to the server's event stream and draws
// every model call, tool step and Contextwaise decision as it happens. Everything
// is driven by events, so a recorded stream replays the same way.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const usd = (n) => "$" + n.toFixed(n < 0.01 ? 5 : 4);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0) + "%";
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
const args = (a) => { const s = JSON.stringify(a ?? {}); return s === "{}" ? "" : s.length > 60 ? s.slice(0, 57) + "…" : s; };

// [question, tool it uses, what that tool returns]
const SUGGESTIONS = [
  ["Why are the tests failing?", "run_tests", "338 test results"],
  ["Any errors in today's logs?", "search_logs", "1,800 log lines"],
  ["Where is the auth middleware?", "list_files", "400+ file paths"],
  ["What did customer Acme order this month?", "get_orders", "JSON API"],
  ["How do I configure rate limits?", "fetch_docs", "HTML page"],
];
const MODES = { full: "passed whole", shaped: "noise removed", trimmed: "relevant parts kept" };
const SCORERS = { local: "local scorer", jev: "relevance model", none: "no scoring" };
const DOTS = 100;

let totals = blankTotals();
let thinking = null;
let pricing = null;
const steps = new Map(); // tool call id -> its card in the timeline

function blankTotals() {
  const money = () => ({ fixed: 0, conv: 0, tools: 0, out: 0 });
  return { calls: 0, with: { tokens: 0, read: 0, cost: 0, money: money() }, without: { tokens: 0, read: 0, cost: 0, money: money() }, raw: 0, sent: 0 };
}

/** Splits a call's cost into the four parts: input cost shared by token count, output priced apart. */
function addMoney(m, b) {
  const out = (b.output * (pricing?.output ?? 0)) / 1e6;
  const input = Math.max(0, b.cost - out);
  const n = b.tokens || 1;
  m.fixed += (input * b.parts.fixed) / n;
  m.conv += (input * b.parts.conversation) / n;
  m.tools += (input * b.parts.toolResults) / n;
  m.out += out;
}

// ---- chat ----

for (const [q, tool, what] of SUGGESTIONS) {
  const big = document.createElement("button");
  big.type = "button";
  big.innerHTML = `<span>${esc(q)}</span><span class="tag" title="${esc(what)}">${esc(tool)}</span>`;
  big.onclick = () => ask(q);
  $("suggest").append(big);
  const chip = document.createElement("button");
  chip.type = "button";
  chip.textContent = q;
  chip.onclick = () => ask(q);
  $("chips").append(chip);
}
$("form").onsubmit = (e) => {
  e.preventDefault();
  const q = $("input").value.trim();
  if (q) ask(q);
};
$("reset").onclick = () => fetch("/api/reset", { method: "POST" });
$("copy").onclick = (e) => {
  e.preventDefault();
  navigator.clipboard.writeText($("log").innerText);
  e.target.textContent = "Copied";
  setTimeout(() => (e.target.textContent = "Copy"), 1200);
};

async function ask(q) {
  $("input").value = "";
  setBusy(true);
  const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: q }) });
  if (!res.ok) {
    thinking?.remove();
    thinking = null;
    addMsg("assistant", "Something went wrong: " + ((await res.json().catch(() => ({}))).error ?? res.statusText));
  }
  setBusy(false);
}

function setBusy(busy) {
  for (const b of document.querySelectorAll("#send, #reset, #suggest button, #chips button")) b.disabled = busy;
  $("input").disabled = busy;
  if (!busy) $("input").focus();
}

function addMsg(role, html) {
  $("welcome").hidden = true;
  $("chips").hidden = false;
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.innerHTML = html;
  $("messages").append(div);
  $("messages").scrollTop = 1e9;
  return div;
}
const typing = (text) => `<span class="typing"><i></i><i></i><i></i></span>${esc(text)}`;

// ---- timeline ----

function intro() {
  $("timeline").innerHTML = `
    <div class="intro">
      <h3>Every step of the answer shows up here.</h3>
      <ol>
        <li><i class="dot model"></i><span><b>The model asks for a tool</b>It decides what to read, and every call is priced.</span></li>
        <li><i class="dot tool"></i><span><b>The tool returns its raw output</b>Often thousands of tokens of logs, JSON or HTML.</span></li>
        <li><i class="dot sw"></i><span><b>Contextwaise trims it before the model reads it</b>You see what was kept, what was cut and why.</span></li>
      </ol>
    </div>`;
}

function addEvent(kind, html, { line = false } = {}) {
  $("timeline").querySelector(".intro")?.remove();
  const div = document.createElement("div");
  div.className = "ev " + kind;
  div.innerHTML = `<i class="dot"></i><div class="${line ? "ev-line" : "ev-card"}">${html}</div>`;
  $("timeline").append(div);
  $("timeline").scrollTop = 1e9;
  return div;
}

/** Input tokens of a model call, split by part, with and without Contextwaise. */
function bars(e) {
  const max = Math.max(e.with.tokens, e.without.tokens) || 1;
  const w = (n) => `width:${(n / max) * 100}%`;
  const row = (label, b, raw) => `
    <span>${label}</span>
    <span class="bar" title="system + tools ${fmt(b.parts.fixed)} · conversation ${fmt(b.parts.conversation)} · tool outputs ${fmt(b.parts.toolResults)}">
      <span class="fixed" style="${w(b.parts.fixed)}"></span><span class="conv" style="${w(b.parts.conversation)}"></span><span class="tools ${raw ? "raw" : ""}" style="${w(b.parts.toolResults)}"></span>
    </span>
    <span class="num">${fmt(b.tokens)}</span>`;
  return `<div class="bars">${row("with", e.with, false)}${e.expandOnly ? "" : row("without", e.without, true)}</div>`;
}

function sectionsTable(r) {
  if (!r.sections.length) return "";
  const rows = [...r.sections].sort((a, b) => Number(b.kept) - Number(a.kept) || b.score - a.score).slice(0, 14);
  return `<details ${r.mode === "trimmed" ? "open" : ""}><summary>How each part was judged · ${r.sections.filter((s) => s.kept).length} kept of ${r.sections.length} (${SCORERS[r.scorer] ?? r.scorer})</summary>
    <table class="sec">${rows.map((s) => `<tr><td class="${s.kept ? "k" : "d"}">${s.kept ? "✓" : "✗"}</td><td class="num">${s.score.toFixed(2)}</td><td class="meta">${s.reason.replace("_", " ")}</td><td class="p" title="${esc(s.preview)}">${esc(s.preview)}</td></tr>`).join("")}</table>
    ${r.sections.length > 14 ? `<div class="meta" style="margin-top:4px">… ${r.sections.length - 14} more parts</div>` : ""}</details>`;
}

const handlers = {
  hello(e) {
    pricing = e.model;
    $("model").innerHTML = `<b>${esc(e.model.name.replace(" (simulated)", ""))}</b> · ${e.real ? "real API" : "simulated"}`;
    $("t-note").textContent = e.real
      ? `“With” is billed from the provider's own usage report. “Without” replays the same requests with raw tool outputs through a prompt-cache simulator (never sent). Prices per 1M tokens: $${e.model.input} input, $${e.model.cacheRead} cached, $${e.model.output} output.`
      : "Simulated model, billed like Claude's prompt cache. “Without” replays the same requests with raw tool outputs.";
  },
  user(e) {
    $("timeline").querySelector(".intro")?.remove();
    $("timeline").insertAdjacentHTML("beforeend", `<div class="turn"><b>${esc(e.text)}</b></div>`);
    addMsg("user", esc(e.text));
    thinking = addMsg("assistant thinking", typing("Thinking…"));
  },
  "llm.call"(e) {
    const asks = e.toolCalls.map((c) => `<span class="pill">${esc(c.name)}${args(c.args) ? " " + esc(args(c.args)) : ""}</span>`).join("") || `<span class="pill lime">final answer</span>`;
    addEvent("model", `
      <div class="head"><span class="tag">Model</span><span class="title">Call ${e.step}</span><span class="meta">${e.ms} ms · ${usd(e.with.cost)}${e.expandOnly ? "" : ` <span class="muted">vs ${usd(e.without.cost)}</span>`}</span></div>
      ${e.said && e.toolCalls.length ? `<div class="said">“${esc(e.said)}”</div>` : ""}
      <div style="margin-top:6px">${asks}</div>
      ${bars(e)}
      <details><summary>Token details</summary><div class="meta" style="white-space:normal;margin-top:6px;line-height:1.7">
        system + tools ${fmt(e.with.parts.fixed)} · conversation ${fmt(e.with.parts.conversation)} · tool outputs ${fmt(e.with.parts.toolResults)} (without: ${fmt(e.without.parts.toolResults)})<br>
        ${pct(e.with.cacheRead, e.with.tokens)} read from cache (${fmt(e.with.cacheRead)}) · ${fmt(e.with.cacheWrite)} not cached · ${fmt(e.with.output)} output${e.withEstimated ? "" : " · billed usage"}</div></details>
      ${e.expandOnly ? `<span class="extra">Extra round trip: only runs expand, so it has no cost without Contextwaise</span>` : ""}`);
    if (thinking && e.said) thinking.innerHTML = typing(e.said);
    totals.calls++;
    totals.with.tokens += e.with.tokens; totals.with.read += e.with.cacheRead; totals.with.cost += e.with.cost;
    totals.without.tokens += e.without.tokens; totals.without.read += e.without.cacheRead; totals.without.cost += e.without.cost;
    addMoney(totals.with.money, e.with);
    if (!e.expandOnly) addMoney(totals.without.money, e.without);
    renderTotals();
  },
  "tool.call"(e) {
    const el = addEvent("tool", `
      <div class="head"><span class="tag">Tool</span><span class="title mono">${esc(e.tool)}${args(e.args) ? ` <span class="muted">${esc(args(e.args))}</span>` : ""}</span><span class="meta status"><span class="spin"></span></span></div>
      <div class="body"></div>`);
    steps.set(e.callId, el);
  },
  "tool.output"(e) {
    totals.raw += e.tokens;
    renderTotals();
    const el = steps.get(e.callId);
    if (!el) return;
    el.querySelector(".status").textContent = `${fmt(e.tokens)} tokens returned`;
    el.querySelector(".body").innerHTML = `
      <div class="step"><span class="muted">tool returned</span><span class="track"><span class="raw"></span></span><span class="num">${fmt(e.tokens)}</span></div>
      <div class="step sw-row"><span class="muted">model reads</span><span class="track"><span class="kept" style="width:0"></span></span><span class="num"><span class="spin" style="display:inline-block"></span></span></div>
      <details><summary>Raw output (what the model would read without Contextwaise)</summary><pre>${esc(e.full)}</pre></details>
      <div class="sw-out"></div>`;
  },
  shrink(e) {
    const r = e.result;
    totals.sent += r.tokensAfter;
    renderTotals();
    const el = steps.get(e.callId);
    const saved = r.tokensBefore - r.tokensAfter;
    const html = `
      <div class="verdict"><span class="dot sw"></span><b>Contextwaise</b><span class="muted">· ${MODES[r.mode]} · ${esc(r.kind)} · ${e.ms} ms</span>
        ${saved > 0 ? `<span class="big" style="margin-left:auto">−${pct(saved, r.tokensBefore)}</span>` : `<span class="muted" style="margin-left:auto">fits, sent whole</span>`}</div>
      ${r.notes.length ? `<ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      ${sectionsTable(r)}
      <details><summary>What the model actually reads</summary><pre>${esc(r.text)}</pre></details>`;
    if (!el) return void addEvent("sw", html);
    el.classList.add("sw");
    const bar = el.querySelector(".sw-row .kept");
    el.querySelector(".sw-row .num").textContent = fmt(r.tokensAfter);
    requestAnimationFrame(() => (bar.style.width = `${Math.max(0.5, (r.tokensAfter / (r.tokensBefore || 1)) * 100)}%`));
    el.querySelector(".sw-out").innerHTML = html;
  },
  replay(e) {
    addEvent("sw", `<b>${esc(e.tool)}</b> sent again exactly as before, so the prompt cache stays valid.`, { line: true });
  },
  expand(e) {
    addEvent("sw", `
      <div class="head"><span class="tag">Contextwaise</span><span class="title">The model asked for more: expand</span><span class="meta">${fmt(e.tokens)} tokens returned</span></div>
      ${e.question ? `<div class="said">“${esc(e.question)}”</div>` : ""}
      <div class="said" style="font-size:12px">Nothing is lost: any trimmed part can be fetched back exactly.</div>`);
  },
  api_error(e) {
    addEvent("sw", `<b>Contextwaise API:</b> ${esc(e.message)}`, { line: true });
  },
  engine_fallback(e) {
    addEvent("sw", `Relevance service unavailable, used the local scorer <span class="mono">(${esc(e.error)})</span>`, { line: true });
  },
  assistant(e) {
    thinking?.remove();
    thinking = null;
    addMsg("assistant", md(e.text));
    addEvent("model", `<b>Answer sent</b> to the user, in the chat.`, { line: true });
  },
  "turn.end"() {},
  reset() {
    totals = blankTotals();
    steps.clear();
    thinking = null;
    renderTotals();
    $("messages").querySelectorAll(".msg").forEach((m) => m.remove());
    $("welcome").hidden = false;
    $("chips").hidden = true;
    intro();
    $("log").innerHTML = "";
  },
};

function renderTotals() {
  const t = totals;
  $("t-with").textContent = usd(t.with.cost);
  $("t-without").textContent = usd(t.without.cost);
  $("t-saved").textContent = t.without.cost ? pct(t.without.cost - t.with.cost, t.without.cost) : "–";
  $("t-calls").textContent = `${t.calls} model call${t.calls === 1 ? "" : "s"}`;
  $("t-tokens").textContent = `${fmt(t.with.tokens)} vs ${fmt(t.without.tokens)}`;
  $("t-cache").textContent = `${pct(t.with.read, t.with.tokens)} vs ${pct(t.without.read, t.without.tokens)}`;
  $("t-raw").textContent = fmt(t.raw);
  $("t-sent").textContent = fmt(t.sent);
  const on = t.raw ? Math.max(t.sent ? 1 : 0, Math.round((t.sent / t.raw) * DOTS)) : 0;
  $("t-dots").innerHTML = Array.from({ length: DOTS }, (_, i) => `<i class="${i < on ? "on" : ""}"></i>`).join("");
  const max = Math.max(t.with.cost, t.without.cost) || 1;
  const row = (label, m, total, raw) => `
    <div class="money-row"><span>${label}</span>
      <span class="bar" title="system + tools ${usd(m.fixed)} · conversation ${usd(m.conv)} · tool outputs ${usd(m.tools)} · output ${usd(m.out)}">
        <span class="fixed" style="width:${(m.fixed / max) * 100}%"></span><span class="conv" style="width:${(m.conv / max) * 100}%"></span><span class="tools ${raw ? "raw" : ""}" style="width:${(m.tools / max) * 100}%"></span><span class="out" style="width:${(m.out / max) * 100}%"></span>
      </span><span class="num">${usd(total)}</span></div>`;
  $("money").innerHTML = row("with", t.with.money, t.with.cost, false) + row("without", t.without.money, t.without.cost, true);
}

// ---- log ----

function log(e) {
  const time = new Date(e.at ?? Date.now()).toLocaleTimeString();
  const line = {
    user: () => [`user`, e.text],
    assistant: () => [`assistant`, e.text.split("\n")[0]],
    "llm.call": () => [`llm`, `#${e.step} ${e.ms}ms in=${e.with.tokens} cache_read=${e.with.cacheRead} not_cached=${e.with.cacheWrite} out=${e.with.output} cost=${usd(e.with.cost)} | without: in=${e.without.tokens} cost=${usd(e.without.cost)}`],
    "tool.call": () => [`tool`, `${e.tool}(${JSON.stringify(e.args)})`],
    "tool.output": () => [`tool`, `${e.tool} → ${e.tokens} tokens raw`],
    shrink: () => [`cw`, `${e.tool}: ${e.result.mode} ${e.result.kind} ${e.result.tokensBefore}→${e.result.tokensAfter} tok, ${SCORERS[e.result.scorer] ?? e.result.scorer}, ${e.ms}ms`],
    replay: () => [`cw`, `${e.tool}: replay ${e.callId}`],
    expand: () => [`cw`, `expand ${e.ref} "${e.question ?? ""}" → ${e.tokens} tok`],
    engine_fallback: () => [`cw`, `remote failed: ${e.error}`],
    api_error: () => [`cw`, e.message],
    "turn.end": () => [`turn`, `total with=${usd(e.totals.with.cost)} without=${usd(e.totals.without.cost)}`],
  }[e.type];
  if (!line) return;
  const [cls, text] = line();
  $("log").insertAdjacentHTML("beforeend", `<span class="t-${cls}">${time} [${cls === "cw" ? "contextwaise" : cls}] ${esc(text)}</span>\n`);
  $("log").scrollTop = 1e9;
}

// ---- stream ----

intro();
renderTotals();
const source = new EventSource("/api/events");
source.onmessage = (m) => {
  const e = JSON.parse(m.data);
  handlers[e.type]?.(e);
  log(e);
};
