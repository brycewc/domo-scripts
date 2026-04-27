---
name: domo-api
description: Reference and execution toolkit for the Domo Product API (1600+ endpoints across DataSets, Streams, DataFlows, PDP, Pages, Cards, Users, Groups, Workflows, AI, Buzz, Alerts, and more). Use whenever the user asks to do something in their Domo instance — list, fetch, create, update, delete, share, transfer, schedule, etc. — and there is no obvious existing CLI command in the domo-scripts repo (or the user wants a one-off rather than a reusable command). Bundles the full OpenAPI 3.0 spec plus search/describe/call helper scripts so the AI can find the right endpoint, learn its shape, and call it with the user's developer token.
---

# Domo Product API toolkit

This skill gives you everything you need to discover and call any of the ~1600 endpoints in the Domo Product API. The full OpenAPI spec is bundled — but at 3.7 MB it is too big to read into context. **Always go through the helper scripts.** Don't `cat` or `Read` `openapi.json`.

## What's in this skill

```
domo-api/
├── SKILL.md             ← this file
├── openapi.json         ← full Domo Product API spec (OpenAPI 3.0, 1605 ops, 180 tags)
└── scripts/
    ├── search-api.js    ← discover endpoints (by tag, path, operationId, keyword)
    ├── describe-api.js  ← full details for one operation (params, body, responses)
    └── call-api.js      ← authenticated HTTP request to the user's Domo instance
```

All three scripts are pure Node.js (built-in `fetch`, no `npm install` needed). They locate `openapi.json` next to themselves, so the skill works from anywhere as long as the directory structure is intact.

## Authentication

Every Domo API call needs:
- **Instance** — the subdomain in `https://<instance>.domo.com`
- **Developer access token** — created at *Admin → Security → Access tokens*

The bundled `call-api.js` reads them from environment variables:

```
DOMO_INSTANCE=acme
DOMO_ACCESS_TOKEN=abc123...
```

It also auto-loads a `.env` file if found in (a) the current working directory, or (b) the skill root.

**If those vars aren't set**, ask the user for both before making any call. Never guess values, never paste tokens into chat output, and never write a token into a file the user didn't ask you to create. If the user is in the [domo-scripts repo](../../../), there is already a `.env` at the repo root that works — just `cd` there before running the scripts.

## How to work with the API

A typical flow has three steps. Don't skip steps; doing so leads to wrong endpoints, wrong payloads, and 400s.

### 1. Find the endpoint

Pick the search mode that matches what you know:

```bash
# What tags exist? (best starting point when you don't know what category an endpoint lives under)
node scripts/search-api.js tags

# All endpoints under a given tag
node scripts/search-api.js tag "DataSets and Streams"

# Substring search on the URL path
node scripts/search-api.js path "/streams"

# Find by operationId (or partial)
node scripts/search-api.js op listStreams

# Free-text search across summary, description, operationId
node scripts/search-api.js keyword "schedule"
```

Each result line is `METHOD  /path  operationId  — summary`. Default cap is 50 results; pass `--limit 0` for all.

### 2. Learn the operation's shape

Once you have a `METHOD path` or an `operationId`, get the full contract:

```bash
node scripts/describe-api.js --op listStreams
node scripts/describe-api.js --path "/data/v1/streams" --method GET
node scripts/describe-api.js --op createDataSet --full   # raw schemas, no summarization
node scripts/describe-api.js --op listStreams --json     # machine-readable
```

The default output is summarized: top-level schema keys + examples. Pass `--full` only when summarization isn't enough — full schemas can be huge.

### 3. Make the call

```bash
# GET with query params
node scripts/call-api.js GET /data/v1/streams --query limit=5 --query offset=0

# POST/PUT with inline JSON
node scripts/call-api.js PUT /data/v1/streams/123 --body '{"updateMethod":"APPEND"}'

# POST with a file body (handy for large payloads)
node scripts/call-api.js POST /data/v1/streams --body-file ./create-stream.json

# DELETE
node scripts/call-api.js DELETE /data/v3/datasources/abc-123

# Custom header (rare — auth header is always added automatically)
node scripts/call-api.js GET /some/path --header "X-Foo: bar"

# See the HTTP status alongside the body
node scripts/call-api.js GET /data/v1/streams --status

# Don't exit non-zero on 4xx/5xx (useful when probing for existence)
node scripts/call-api.js GET /data/v1/streams/999999 --no-fail --status
```

`call-api.js` defaults `--base` to `/api`. Almost every endpoint in the spec lives under `/api`; for the rare path that needs `/apiapps` or `/apicontent`, pass `--base /apiapps`. If the user gives you a path that already starts with `/api/...`, the script detects that and won't double-prefix.

## How this skill fits with existing CLI commands

If the user is working inside the [domo-scripts repo](../../../), several common bulk operations are already wrapped as CLI commands. **Prefer those over re-implementing the same thing here**, because they handle CSV input, dry-run, debug logging, rate limiting, and summary reports out of the box. Run `node cli.js --help` to see the current list.

Decision rule:

| Situation | Do this |
|---|---|
| User wants a bulk operation that an existing `node cli.js <name>` command already does | Use the CLI command. Don't reinvent. |
| User wants a one-off operation (single entity, ad-hoc inspection, exploratory call) | Use this skill's `call-api.js` directly. |
| User wants a bulk operation that no CLI command covers | Write a small ad-hoc script in `/tmp/` that loops + calls `call-api.js` (or uses `fetch` directly with the same auth). Don't add it to the CLI. |
| User explicitly asks "add this as a command" / "make a CLI for this" | Switch to the `new-command` skill in this same workspace, which knows the exact conventions for `commands/*.js`. |

The default is **never add to the CLI** unless the user asks for it. The skill is here for direct, in-the-moment use.

## Writing ad-hoc bulk scripts

When the operation is bigger than a single call but doesn't justify a CLI command, write a small throwaway script. Keep it minimal and follow these patterns:

- **Auth**: read `DOMO_INSTANCE` / `DOMO_ACCESS_TOKEN` from `process.env` exactly the way `call-api.js` does — don't hard-code anything.
- **Rate limit**: `await new Promise(r => setTimeout(r, 150))` between calls. The Domo API will 429 you under sustained load.
- **Progress**: log `[i+1/N]` per item so the user can see it's alive.
- **Dry-run by default** for any destructive operation. Make the user pass `--apply` to actually do it.
- **Don't swallow errors**: catch per-item, count failures, exit non-zero if any failed.
- **Pagination**: most list endpoints use `limit` + `offset` (string-typed in the spec). Stop when a page returns < limit, or when `_metaData.totalCount` is reached.
- **Confirm before destructive bulk actions** by printing what will happen and asking the user to type `yes`.

Skeleton (drop into `/tmp/foo.js`, run with `node /tmp/foo.js`):

```js
const instance = process.env.DOMO_INSTANCE;
const token = process.env.DOMO_ACCESS_TOKEN;
if (!instance || !token) { console.error('Set DOMO_INSTANCE and DOMO_ACCESS_TOKEN'); process.exit(2); }

async function call(method, path, body) {
	const res = await fetch(`https://${instance}.domo.com/api${path}`, {
		method,
		headers: {
			'X-DOMO-Developer-Token': token,
			'Content-Type': 'application/json',
			Accept: 'application/json'
		},
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

(async () => {
	// example: list streams 50 at a time
	let offset = 0;
	while (true) {
		const page = await call('GET', `/data/v1/streams?limit=50&offset=${offset}`);
		if (!page.length) break;
		for (const s of page) console.log(s.id, s.dataSource?.name);
		if (page.length < 50) break;
		offset += 50;
		await new Promise((r) => setTimeout(r, 150));
	}
})().catch((e) => { console.error(e.message); process.exit(1); });
```

## Common Domo API conventions to know

These trip people up if you don't know them — keep them in mind when reading spec output:

- **Auth header**: `X-DOMO-Developer-Token: <token>` (handled for you by `call-api.js`).
- **Base URL**: `https://<instance>.domo.com/api` is the default for ~1604 of 1605 operations.
- **Path versions are inconsistent**: you'll see `/data/v1`, `/data/v2`, `/data/v3`, `/dataprocessing/v1`, `/content/v1`, `/users/v1`, etc. — that is the actual API, not a bug. When two versions exist for similar functionality, **use the newest one** unless the user says otherwise.
- **Many list endpoints take string-typed `limit` / `offset`** (see the spec — they're `type: string` even though they're numeric). Pass them as strings or via `--query limit=50` (which URL-encodes correctly either way).
- **`fields` query param**: many GET endpoints accept `fields=` to filter the response shape. Look for `fields` in `--query`. Useful to keep responses small. `fields=all` returns the full document.
- **DataSet IDs are UUIDs**, **Stream/User/DataFlow/Card/Page IDs are numeric**. The spec sometimes says `string` for numeric IDs; that's fine.
- **DataSet vs Stream**: a DataSet is the data; a Stream is the import pipeline that loads into it. They have separate IDs. Editing the *schedule* means editing the Stream; editing the *name/description/owner* means editing the DataSet.
- **PDP (personalized data permissions)** policies live under `/data/v3/datasources/{id}/policies` — one policy per filter rule.
- **Content-sharing endpoint** is `/content/v1/share` (POST) — used for cards, datasets, pages, dataflows. The body's `entityType` switches between them.
- **Rate limiting**: keep ~100–200 ms between calls in loops. Bulk batch endpoints exist for tags, deletes, and shares — use them when you can rather than per-item calls.

## Things to avoid

- **Don't read `openapi.json` directly** — it's 3.7 MB on one line. Use the search/describe scripts.
- **Don't run any destructive call** (DELETE, owner transfer, schedule wipe) without confirming with the user first, even if they asked for it generally. Show them the list of affected entities, then ask.
- **Don't store the access token anywhere** — not in committed files, not in a script you write, not in chat output. If you need it in a script, pull it from `process.env.DOMO_ACCESS_TOKEN`.
- **Don't pick a v1 endpoint when a v3 exists** unless v3 doesn't have what you need. Confirm by `search-api.js path "/datasources"` to see versions side-by-side.
- **Don't add a CLI command** to wrap a one-off request — just call the API. CLI commands are for repeatable bulk operations the user will run again.
- **Don't trust schema examples blindly** — many examples in the spec are anonymized placeholders (`1234`, `abc-123`, sample dates). The shape is reliable; the values are not.

## Quick reference

| I want to… | Run |
|---|---|
| See what categories of endpoints exist | `node scripts/search-api.js tags` |
| Find an endpoint for a feature | `node scripts/search-api.js keyword "the feature"` |
| Find every endpoint that mentions a path piece | `node scripts/search-api.js path "/streams"` |
| Get parameters + body + response shape for one op | `node scripts/describe-api.js --op <operationId>` |
| Make a single API call | `node scripts/call-api.js <METHOD> <path> [--body … / --query k=v]` |
| Probe whether something exists (allow 4xx) | add `--no-fail --status` to `call-api.js` |
| Page through a list endpoint | loop with `--query limit=50 --query offset=N` until empty |
