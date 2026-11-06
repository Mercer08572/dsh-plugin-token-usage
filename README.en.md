<p align="center">
  <img src="./icon.svg" width="84" alt="Token Usage icon">
</p>
<h1 align="center">Token Usage</h1>

<p align="center">
  A token dashboard for DSH: how much you spent today, on which model, and how much of it came from cache.<br>
  Everything is read from local session logs — no network calls, no telemetry.
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.md">简体中文</a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/platform-DSH-22c1a4" alt="Platform: DSH">
  <img src="https://img.shields.io/badge/storage-SQLite-12806f" alt="Storage: SQLite">
</p>

## About

Token Usage is a plugin for DSH (DeepSeek Harness). It reads your local session logs, turns every model
call into a single row, and renders the result as a dashboard.

Once installed, a **Token usage** button appears at the bottom of the sidebar. Opening it gives you a full
page: four summary cards, a daily trend, a 53-week heatmap, and a paged request log. There is nothing to
configure and no recording to start — past sessions are backfilled automatically on first launch.

## Features

| Capability | What you get |
| --- | --- |
| Summary cards | Total cost, requests, tokens and cache hit rate, each with today's delta; failures and cancellations live in a hover tooltip |
| Daily trend | Last 7 / 30 / 90 days as stacked bars (uncached input, cache read, output) with a request-count line on top |
| Heatmap | 53 weeks, five intensity levels by daily token volume; empty days keep their square so gaps are obvious |
| Request log | Time, model, input, output, cache read, hit rate, speed, time-to-first-token and cost, with model filter and pagination |
| Follows the UI language | ¥ for Chinese, $ for everything else — nothing to configure |
| Local storage | One SQLite file; delete it and everything is gone |

## Interface

The panel is four blocks, top to bottom:

```
┌────────┬────────┬────────┬────────┐
│  Cost  │Requests│ Tokens │ Cache  │   summary cards with today's delta
├────────┴────────┴────────┴────────┤
│  Daily trend (stacked bars + line) │   7 / 30 / 90 days
├───────────────────────────────────┤
│  53-week calendar heatmap          │
├───────────────────────────────────┤
│  Request log  ▸ filter · pages     │
└───────────────────────────────────┘
```

The top right corner holds settings and close. Settings can adjust pricing and holidays; the exchange rate
refreshes daily and needs no configuration. These are advanced knobs you will rarely need.

## Installation

Token Usage is a DSH bundle plugin, installed into a profile:

1. Put this repository anywhere on disk.
2. Open DSH and install that directory with the plugin manager (do not hand-edit the profile's `cordis.patch.yml`).
3. Restart DSH.

The first launch backfills past sessions in the background, which takes about fifteen seconds. The panel
shows *Backfilling past sessions* and refreshes itself; when it disappears, the numbers are complete.

## Data and privacy

- Everything stays on your machine, in `~/.dsh/token-usage/usage.db`.
- The plugin only reads DSH's own session logs. It makes no outbound requests, apart from one optional
  exchange-rate lookup at first launch.
- To reset, delete that directory. To migrate, copy a single file.

## What the numbers mean

- **Successful calls only.** Failed and cancelled attempts are counted separately and never enter token totals or cost.
- **Time to first token** is measured from request start to the first token; **speed** is output tokens over decode time.
- **Cost** is computed when each request settles, using the price in effect at that moment, and is marked
  as indicative only. Later price edits affect new requests only.
- Costs require a price per model. Without one the column stays empty — it never pretends to be zero.

## Development

Four offline checks ship with the repo; none of them need DSH running:

```bash
node tools/check.mjs          # syntax / manifest / component registration / pricing file
node tools/selftest.mjs       # exercises the host pipeline with a fake ctx (temp dir, real data untouched)
node tools/replay.mjs         # replays real session logs to reconcile totals and cost
node tools/render-smoke.mjs   # smoke-renders the client components
```

The code is three layers:

| File | Role |
| --- | --- |
| `lib/core.js` | Pure logic: event → record, time bucketing, price matching (shared with the offline tools) |
| `lib/index.js` | Host: SQLite, event subscription, history backfill, HTTP endpoints |
| `lib/client.js` | UI: cards, charts, heatmap, log, settings dialogs |

## License

[MIT](./LICENSE)
