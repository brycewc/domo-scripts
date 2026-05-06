# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CLI toolkit for automating and managing Domo business intelligence instances. All commands run through a single entry point (`cli.js`) and share common libraries for API access, CSV parsing, input resolution, and logging.

## Setup & Commands

```bash
yarn install                          # Install dependencies
cp .env.example .env                  # Then fill in DOMO_INSTANCE and DOMO_ACCESS_TOKEN
node cli.js --help                    # List all available commands
node cli.js <command> --help          # Command-specific options
```

There is no build step, test suite, or linter configured.

### Example Invocations

```bash
node cli.js upload-dataset --file "data.csv" --dataset-id "<id>" --batch-size 50000
node cli.js bulk-update-stream-schedules --file "streams.csv" --start-hour 6 --end-hour 20 --timezone "America/Denver"
node cli.js bulk-add-dataflow-trigger-condition --dataflow-id 123
node cli.js bulk-share-content --file "content.csv" --user "<userId>" --content-type "card"
node cli.js bulk-delete-datasets --file "datasets.csv" --column "DataSet ID" --dry-run
```

## Architecture

### Entry Point

- [cli.js](cli.js) — Dispatches subcommands. Maps command names to files in `commands/`. Splices the command name out of `process.argv` before requiring the command module, so commands use `minimist(process.argv.slice(2))` as normal.

### Configuration

- [.env](.env) — Environment variables: `DOMO_ACCESS_TOKEN` (required) and `DOMO_INSTANCE` (defaults to `"domo"`). Git-ignored.
- [.env.&lt;name&gt;](.env.example) — Per-environment overrides selected at runtime with `--env <name>` (e.g. `.env.prod`, `.env.sandbox`). Loaded in addition to `.env`. Git-ignored.
- [.env.example](.env.example) — Template for `.env`.
- [id-mappings/](id-mappings) — Per-env-pair old→new ID maps (`<source>_to_<target>.json`). Written by `transfer-stream` (and future migration commands). Each file holds arrays of `{ name, oldId, newId }` keyed by kind (`accounts`, `providers`, `users`, `streams`, `datasets`, `dataflows`). Git-ignored. Account/user/provider mappings must be populated manually before transferring assets that reference them.

### Shared Libraries (lib/)

All shared code is re-exported from [lib/index.js](lib/index.js), so commands can import everything in one line:

```js
const { api, config, readCSV, resolveIds, createLogger } = require('../lib');
```

| Module                     | Exports                                                              | Purpose                                                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [config.js](lib/config.js) | `instance`, `instanceUrl`, `baseUrl`, `accessToken`, `env`, `requireAuth()`, `loadEnvConfig(name)` | Reads `.env` via dotenv (and `.env.<name>` when `DOMO_ENV` / `--env` is set). Module-level exports describe the *default* instance. `loadEnvConfig(name)` reads a specific `.env.<name>` without touching `process.env` and returns `{ env, instance, instanceUrl, baseUrl, accessToken }` — used by transfer commands that need a second instance. |
| [api.js](lib/api.js)       | `createApiClient({ baseUrl, accessToken, instance })`, plus default singleton: `get`, `put`, `post`, `patch`, `del`, `request` | The default singleton uses module-level config (and lazily calls `requireAuth()` on first request, so `--help` works without a token). Two-instance commands call `createApiClient(loadEnvConfig(name))` to get a second client bound to a different instance.                                                              |
| [id-mapping.js](lib/id-mapping.js) | `loadMapping(sourceEnv, targetEnv)`, `translate(mapping, kind, oldId)`, `recordMapping(mapping, kind, entry)`, `saveMapping(mapping)`, `resolveOrPrompt(mapping, kind, oldId, opts)`, `KINDS` | Reads/writes `id-mappings/<source>_to_<target>.json`. `kind` is one of `accounts`, `providers`, `users`, `streams`, `datasets`, `dataflows`. Entries are `{ name, oldId, newId }`. Multiple env-pairs coexist — each pair has its own file. `resolveOrPrompt` looks up an ID and, if missing, prompts the user (via `readline/promises`) for the target-instance equivalent, persists the entry to disk, and returns the new ID. Returns `null` if the user enters blank (skip). Throws if stdin isn't a TTY and the default prompt would have been used. Use this in any transfer command that needs to translate IDs without forcing the user to pre-populate the mapping file. |
| [rewrite.js](lib/rewrite.js) | `rewriteDomain(value, source, target) → { value, count }` | Recursively replaces every occurrence of `source` (e.g. `domo.domo.com`) with `target` in any string inside `value`. Walks arrays and plain objects. JSON-encoded strings (like Domo's `configuration[].value` blobs) are treated as ordinary strings — a literal substring replace inside the encoded form is still valid JSON because hostnames don't contain any characters JSON has to escape. Used by `transfer-stream`'s `--rewrite-domain` flag for Domo-on-Domo (governance) transfers. |
| [csv.js](lib/csv.js)       | `readCSV(filePath, { column, filterColumn, filterValue })`           | Parses CSV with optional row filtering and column extraction. Returns extracted values (if `column` set) or full record objects.                                                                                                                                               |
| [input.js](lib/input.js)   | `resolveIds(argv, { name, columnDefault })`                          | Resolves entity IDs from `--file` (CSV), `--<name>-id` (single, enables debug mode), or `--<name>-ids` (comma-separated). Also handles `--column`, `--filter-column`, `--filter-value`. Returns `{ ids, debugMode }`.                                                          |
| [log.js](lib/log.js)       | `createLogger(commandName, { debugMode, dryRun, runMeta, instances })` | Returns `{ writeDebugLog(itemId, data), addResult(entry), writeRunLog(summary) }`. In debug mode (single-ID), writes per-item JSON logs. In bulk mode, collects results and writes a summary run log. Logs go to `logs/<commandName>/`. Dry-run logs are prefixed with `dry_`. Single-instance runs stamp `env`/`instance`; if `instances: { source, target }` is passed (transfer commands), that replaces the single-instance fields. |

### Commands (commands/)

19 command modules, each a standalone async script loaded by `cli.js`. Filenames are kebab-case matching the command name (e.g. `node cli.js bulk-update-stream-schedules` loads `commands/bulk-update-stream-schedules.js`).

**When adding a new command:**

1. Create `commands/your-command.js`
2. Add an entry to the `commands` map in `cli.js`
3. Use shared libs instead of manual fetch/CSV/logging code
4. Add `--help` handling early in main (before `requireAuth` is triggered)

Key categories:

- **Bulk tagging/triggers**: `bulk-add-dataflow-tags`, `bulk-add-dataset-tags`, `bulk-add-dataflow-trigger-condition`
- **Bulk deletion**: `bulk-delete-datasets`
- **Bulk rename**: `bulk-rename-dataflows`, `bulk-rename-datasets`
- **PDP policies**: `bulk-apply-pdp-policies`, `bulk-update-column-pdp-policy`
- **Content access**: `bulk-share-content`, `bulk-revoke-content`
- **Stream/schedule management**: `bulk-update-stream-schedules`, `bulk-update-stream-update-method`, `bulk-convert-stream-provider`
- **Cross-instance migration**: `transfer-stream` (uses `--source-env` / `--target-env` + `id-mappings/`)
- **Ownership management**: `bulk-transfer-ownership`
- **DataFlow management**: `swap-input-in-dataflows`
- **Data upload/export**: `upload-dataset`, `bulk-export-dataset-versions`
- **Utilities**: `extract-card-ids`

### Logs

Written to `logs/<commandName>/` (git-ignored). Two log types:

- **Debug logs** (`debug_<itemId>_<timestamp>.json`) — detailed per-item logs in single-ID mode (`--<entity>-id`)
- **Run logs** (`run_<timestamp>.json`) — summary with all results in bulk mode
- Dry-run variants prefixed with `dry_`

## Domo API Conventions

- Auth header: `X-DOMO-Developer-Token: <accessToken>`
- Base URL pattern: `https://{instance}.domo.com/api`
- The shared `api` module handles auth and JSON parsing automatically. For non-JSON content types (CSV upload/download), commands use raw `fetch` with auth from `config`.
- Common API paths:
  - DataFlows: `/dataprocessing/v1/dataflows`
  - Streams: `/data/v1/streams`
  - Datasets: `/data/v3/datasources`
  - Content sharing: `/content/v1/content-access/share`
- Commands handle pagination and batch processing internally with rate-limiting delays (100–200ms between calls)

## Dependencies

- `dotenv` — Loads `.env` into `process.env`
- `csv-parse` — CSV parsing (sync mode)
- `minimist` — CLI argument parsing
- `sanitize-filename` — Safe file naming for exports
