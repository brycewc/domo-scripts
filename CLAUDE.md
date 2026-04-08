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
node cli.js upload-dataset --file "data.csv" --datasetId "<id>" --batchSize 50000
node cli.js update-stream-schedules --file "streams.csv" --startHour 6 --endHour 20 --timezone "America/Denver"
node cli.js bulk-add-dataflow-trigger-condition --dataflowId 123
node cli.js share-content-bulk --file "content.csv" --user "<userId>" --contentType "card"
node cli.js bulk-delete-datasets --file "datasets.csv" --column "DataSet ID" --dryRun
```

## Architecture

### Entry Point

- [cli.js](cli.js) — Dispatches subcommands. Maps command names to files in `commands/`. Splices the command name out of `process.argv` before requiring the command module, so commands use `minimist(process.argv.slice(2))` as normal.

### Configuration

- [.env](.env) — Environment variables: `DOMO_ACCESS_TOKEN` (required) and `DOMO_INSTANCE` (defaults to `"domo"`). Git-ignored.
- [.env.example](.env.example) — Template for `.env`.
- [idMapping.json](idMapping.json) — Maps old IDs to new IDs (accounts, providers, users, streams, datasets, dataflows) for cross-instance migration. Used by `createDataflow`, `createStream`, and others. Not checked in — copy from source instance as needed.

### Shared Libraries (lib/)

All shared code is re-exported from [lib/index.js](lib/index.js), so commands can import everything in one line:

```js
const { api, config, readCSV, resolveIds, createLogger } = require('../lib');
```

| Module | Exports | Purpose |
|--------|---------|---------|
| [config.js](lib/config.js) | `instance`, `instanceUrl`, `baseUrl`, `accessToken`, `requireAuth()` | Reads `.env` via dotenv. `requireAuth()` exits with an error if token is missing — called lazily so `--help` works without a `.env`. |
| [api.js](lib/api.js) | `get(path)`, `put(path, body)`, `post(path, body)`, `del(path)` | Authenticated Domo API client. Paths are relative to `baseUrl` (e.g. `/data/v1/streams/123`). Automatically sets `X-DOMO-Developer-Token` and `Content-Type: application/json`. Throws on non-OK responses. |
| [csv.js](lib/csv.js) | `readCSV(filePath, { column, filterColumn, filterValue })` | Parses CSV with optional row filtering and column extraction. Returns extracted values (if `column` set) or full record objects. |
| [input.js](lib/input.js) | `resolveIds(argv, { name, columnDefault })` | Resolves entity IDs from `--file` (CSV), `--<name>Id` (single, enables debug mode), or `--<name>Ids` (comma-separated). Also handles `--column`, `--filterColumn`, `--filterValue`. Returns `{ ids, debugMode }`. |
| [log.js](lib/log.js) | `createLogger(commandName, { debugMode, dryRun, runMeta })` | Returns `{ writeDebugLog(itemId, data), addResult(entry), writeRunLog(summary) }`. In debug mode (single-ID), writes per-item JSON logs. In bulk mode, collects results and writes a summary run log. Logs go to `logs/<commandName>/`. Dry-run logs are prefixed with `dry_`. |

### Commands (commands/)

31 command modules, each a standalone async script loaded by `cli.js`. Filenames are kebab-case matching the command name (e.g. `node cli.js update-stream-schedules` loads `commands/update-stream-schedules.js`).

**When adding a new command:**
1. Create `commands/your-command.js`
2. Add an entry to the `commands` map in `cli.js`
3. Use shared libs instead of manual fetch/CSV/logging code
4. Add `--help` handling early in main (before `requireAuth` is triggered)

Key categories:
- **Bulk tagging/triggers**: `bulk-add-dataflow-tags`, `bulk-add-dataset-tags`, `bulk-add-dataflow-trigger-condition`
- **Bulk approval/deletion**: `bulk-approve-dataflow-schedules`, `bulk-approve-dataset-schedules`, `bulk-delete-datasets`
- **Bulk rename**: `bulk-rename-dataflows`, `bulk-rename-datasets`
- **PDP policies**: `bulk-apply-pdp-policies`, `update-column-pdp-policy`
- **Content access**: `share-content-bulk`, `revoke-content-bulk`
- **Stream/schedule management**: `update-stream-schedules`, `bulk-update-streams`, `convert-stream-provider`, `switch-provider`
- **DataFlow management**: `copy-dataflow`, `create-dataflow`, `create-stream`, `create-beast-modes`, `swap-input-in-dataflows`
- **Data upload/export**: `upload-dataset`, `export-dataset-versions`
- **Utilities**: `get-page-cards`, `compare-cards`, `extract-card-ids`, `json-array-length`, `query-to-json`, `read-account-credentials`
- **Workflow**: `run-workflow-in-batches`, `user-attribute-updates-workflow-run`

### Logs

Written to `logs/<commandName>/` (git-ignored). Two log types:
- **Debug logs** (`debug_<itemId>_<timestamp>.json`) — detailed per-item logs in single-ID mode
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
