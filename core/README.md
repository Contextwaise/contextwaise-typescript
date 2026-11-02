<p align="center">
  <a href="https://contextwaise.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://contextwaise.com/logo-dark.png">
      <img src="https://contextwaise.com/logo.png" alt="Contextwaise" width="280">
    </picture>
  </a>
</p>

<p align="center"><strong>The rules that decide what context reaches your model.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@contextwaise/core"><img src="https://img.shields.io/npm/v/@contextwaise/core?label=%40contextwaise%2Fcore&labelColor=171717&color=80cd00" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@contextwaise/core"><img src="https://img.shields.io/npm/types/@contextwaise/core?labelColor=171717&color=80cd00" alt="TypeScript types"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@contextwaise/core?labelColor=171717&color=80cd00" alt="Node version"></a>
  <a href="https://opensource.org/license/mit"><img src="https://img.shields.io/badge/license-MIT-80cd00?labelColor=171717" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://contextwaise.com">Website</a> ·
  <a href="https://www.npmjs.com/package/contextwaise">contextwaise SDK</a>
</p>

---

Pure and deterministic: no network, no database, runs in Node, browsers and edge
runtimes. Used by the [`contextwaise`](https://www.npmjs.com/package/contextwaise) SDK
and the Contextwaise API.

| Module | What it decides |
|---|---|
| `shapers.ts` | Cleanup by content type: terminal codes and progress bars, passing tests, repeated log lines, empty JSON fields, HTML to text, file listings. Errors are never removed; plain text is never touched. |
| `engine.ts` | Selection: drop items below the relevance threshold, drop near-duplicates of kept items, stop at the token budget. Kept items stay in the caller's order. |
| `conversation.ts` | Cache-safe mode: an item's decision is made once per conversation and replayed, so history never changes. Only a fingerprint of each item is stored, in your `DecisionStore`. |
| `models.ts` | LLM prices (input, output, cache) for costing requests. |
| `relevance.ts` | Word overlap, used only to order lines inside a part already judged relevant. Never decides what is kept. |

Relevance scores are the caller's: `select()` takes items already scored on a 0 to 3
scale (0 unrelated, 1 loosely related background, 2 useful evidence, 3 essential).

```bash
npm install @contextwaise/core
```

```ts
import { cleanCandidate, keepThreshold, select, estimateTokens } from "@contextwaise/core";

const items = candidates.map(cleanCandidate).map((c) => ({ ...c, tokens: estimateTokens(c.text), score: scores.get(c.id)! }));
const decisions = select(items, 6000, keepThreshold("balanced"));
```

## Development

From the repository root, `npm install` links this package into the app and the SDK,
which read its source directly (the `contextwaise-source` export condition), so
changes need no rebuild. Published builds use `dist/`.

```bash
npm test          # in core/
npm run typecheck
npm run build     # dist/: ESM + types
```
