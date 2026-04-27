---
name: new-command
description: Scaffold a new CLI command in the domo-scripts repo. Use when the user asks to add, create, or write a new command, script, or sub-command for cli.js (e.g. "add a command that bulk-disables alerts", "write a script to export users", "new domo-scripts command"). Covers file placement, cli.js registration, shared lib usage (api, resolveIds, createLogger, showHelp), help text, dry-run, and README updates.
---

# Adding a new command to domo-scripts

Every command in this repo is a standalone async script in [commands/](../../../commands/), dispatched by [cli.js](../../../cli.js), and built on the shared libs in [lib/](../../../lib/). Follow this skill exactly — don't invent new conventions, don't add tests/lint config, don't write your own CSV parser or fetch wrapper.

## Required steps

1. **Create the command file** at `commands/<kebab-name>.js`. The filename must match the command name passed to `node cli.js <name>` exactly (e.g. `bulk-disable-alerts` → `commands/bulk-disable-alerts.js`).
2. **Register it** in the `commands` map in [cli.js](../../../cli.js). Keep the existing alphabetical-ish grouping if the user has one; otherwise add it in a sensible spot. The value is `'./commands/<kebab-name>'` (no `.js`).
3. **Use shared libs** — never re-implement them:
   - `api` — authenticated `get/put/post/patch/del` against the Domo API
   - `resolveIds` — handles `--file`/`--<name>-id`/`--<name>-ids` + filtering uniformly
   - `createLogger` — debug logs (single-ID mode) and run logs (bulk mode), with dry-run prefixing
   - `showHelp` — exits early on `--help`/`-h` so users can see options without a `.env`
4. **Add `--help` handling first**, before any auth or API call. `showHelp(argv, HELP_TEXT)` calls `process.exit(0)` if the flag is set.
5. **Update [README.md](../../../README.md)** — add a row to the command table (the `## Commands` section). One-line description, present tense, lowercase first letter ("Add tags to..." not "Adds tags to..." style varies, match neighbors).
6. **Run `node cli.js <name> --help`** to confirm it loads and the help text renders.

## Standard command skeleton

Use this as the starting point. Drop unused pieces (e.g. omit `createLogger` if there's no per-item processing, omit `resolveIds` if the command doesn't take a list of IDs).

```js
/**
 * <One-line description of what the command does>
 *
 * Usage:
 *   node cli.js <command-name> --file "items.csv" --some-flag value
 *   node cli.js <command-name> --<entity>-id 12345
 *   node cli.js <command-name> --<entity>-ids "1,2,3" --dry-run
 *
 * Options:
 *   --file, -f          CSV file with IDs
 *   --<entity>-id       Single ID (enables debug logging)
 *   --<entity>-ids      Comma-separated IDs
 *   --column, -c        CSV column with IDs (default: "<entity>Id")
 *   --filter-column     CSV column to filter on
 *   --filter-value      Value the filter-column must equal
 *   --dry-run           Preview changes without applying them
 */

const api = require('../lib/api');
const { resolveIds } = require('../lib/input');
const { createLogger } = require('../lib/log');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js <command-name> [options]

Options:
  --file, -f        CSV file with IDs
  --<entity>-id     Single ID (enables debug logging)
  --<entity>-ids    Comma-separated IDs
  --column, -c      CSV column with IDs (default: "<entity>Id")
  --filter-column   CSV column to filter on
  --filter-value    Value the filter-column must equal
  --dry-run         Preview changes without applying`;

async function main() {
	showHelp(argv, HELP_TEXT);

	const dryRun = argv['dry-run'] || false;

	const { ids, debugMode } = resolveIds(argv, {
		name: '<entity>',           // e.g. "stream", "dataset", "dataflow"
		columnDefault: '<entity>Id' // CSV column fallback
	});

	const logger = createLogger('<commandName>', {
		debugMode,
		dryRun,
		runMeta: {
			file: argv.file || argv.f || null,
			column: argv.column || argv.c || '<entity>Id',
			total: ids.length
		}
	});

	console.log('<Banner Title>');
	console.log('================\n');
	if (dryRun) console.log('DRY RUN (no changes will be made)');
	console.log(`Found ${ids.length} item(s) to process\n`);

	let successCount = 0;
	let errorCount = 0;

	for (let i = 0; i < ids.length; i++) {
		const id = ids[i];
		console.log(`[${i + 1}/${ids.length}] Processing ${id}...`);

		const debugLog = debugMode ? { id, timestamp: new Date().toISOString() } : null;
		const entry = { id, status: null, error: null };

		try {
			// ... do the work via api.get / api.put / api.post / api.del ...
			if (dryRun) {
				console.log('  [DRY RUN] Would update');
				entry.status = 'dry-run';
			} else {
				// const result = await api.put(`/some/path/${id}`, body);
				console.log('  ✓ Updated');
				entry.status = 'updated';
			}
			successCount++;
		} catch (error) {
			console.error(`  ✗ Error: ${error.message}`);
			entry.status = 'error';
			entry.error = error.message;
			if (debugLog) debugLog.error = error.message;
			errorCount++;
		}

		if (debugLog) logger.writeDebugLog(`<entity>_${id}`, debugLog);
		logger.addResult(entry);

		// Rate limiting between calls
		if (i < ids.length - 1) {
			await new Promise((r) => setTimeout(r, 150));
		}
	}

	console.log('\n=== Summary ===');
	console.log(`Total:      ${ids.length}`);
	console.log(`Successful: ${successCount}`);
	console.log(`Errors:     ${errorCount}`);

	logger.writeRunLog({ successCount, errorCount });

	if (errorCount > 0) {
		console.error('\nSome items failed. Check the error messages above.');
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
```

## Conventions enforced across the repo

These are not optional — every command follows them. Match the style.

- **Tabs for indentation** (see existing commands; the repo uses tabs, not spaces).
- **Block comment header** at the top of the file with `Usage:` and `Options:` sections — this duplicates `HELP_TEXT` but is intentional (file-level docs vs runtime help).
- **`HELP_TEXT` is a top-level `const`**, passed to `showHelp(argv, HELP_TEXT)` as the very first line of `main()`.
- **`argv` is parsed once at the top** with `require('minimist')(process.argv.slice(2))`. Don't slice differently — `cli.js` already removes the command name.
- **Short flag aliases** (`-f`, `-c`, `-t`, etc.) are read with `argv.file || argv.f`. Don't configure minimist `alias` — the codebase reads both forms inline.
- **Banner** at the start of `main()`: title line, equals-sign underline, blank line, then key parameters echoed back. See [bulk-rename-datasets.js:146-152](../../../commands/bulk-rename-datasets.js) and [bulk-update-stream-schedules.js:178-188](../../../commands/bulk-update-stream-schedules.js).
- **Progress prefix** `[i+1/total]` on each iteration.
- **Rate limiting** between iterations: `await new Promise(r => setTimeout(r, 100-200))`. Skip after the last item.
- **Summary block** at the end: `=== Summary ===`, then counts, then non-zero `process.exit(1)` if any errors.
- **Console symbols**: `✓` for success, `✗` for error, `[DRY RUN]` prefix for previewed actions.
- **API paths are relative** to `config.baseUrl` — pass `/data/v1/streams/123`, not the full URL. `api.js` adds the host and auth header.
- **No try/catch around the whole `main()`** — use `main().catch(err => { console.error(...); process.exit(1); })` at the bottom. (A few commands also register `process.on('uncaughtException', ...)`; that's fine but not required.)

## When to use `resolveIds` vs custom argv parsing

Use `resolveIds` whenever the command operates on a list of entity IDs that the user supplies via CSV / single ID / comma list. It enforces the `--file` + `--<name>-id` + `--<name>-ids` + `--column` + `--filter-column`/`--filter-value` contract uniformly and returns `debugMode = true` when a single ID was passed (which switches the logger into per-item debug-log mode).

Skip it (and parse argv directly) only when the command's input doesn't fit that shape — e.g. find/replace across the whole instance ([bulk-rename-datasets.js](../../../commands/bulk-rename-datasets.js)), uploading a file ([upload-dataset.js](../../../commands/upload-dataset.js)), or extracting from a JSON export ([extract-card-ids.js](../../../commands/extract-card-ids.js)).

## When to use `createLogger`

Use it whenever the command processes a list of items and there's value in:
- A summary JSON of the run for audit purposes (always useful for bulk operations)
- A detailed per-item dump in single-ID debug mode (useful when developing/debugging)

The `commandName` argument becomes the subdirectory under `logs/`. Use camelCase here (e.g. `'updateStreamSchedules'`, not `'bulk-update-stream-schedules'`) to match existing log directories.

Skip the logger only for commands that don't iterate over items, or whose output is itself the log (like `bulk-export-dataset-versions`).

## Things to avoid

- **Don't** create new files in `lib/` unless the helper is genuinely shared by multiple commands. Inline command-specific helpers near the top of the command file.
- **Don't** add `package.json` scripts for new commands. Everything runs through `node cli.js <name>`.
- **Don't** add tests, ESLint rules, or types — the repo has none for commands.
- **Don't** call `config.requireAuth()` directly; `api.js` does it lazily on first request, so `--help` works without a `.env`.
- **Don't** use `axios`, `node-fetch`, or other HTTP libs — stick with `lib/api.js` (or raw `fetch` only for non-JSON content like CSV upload/download).
- **Don't** swallow errors silently. Catch per-item, log them, count them, and exit non-zero if any failed.

## Quick checklist

- [ ] `commands/<kebab-name>.js` created
- [ ] Block-comment header with Usage + Options
- [ ] `HELP_TEXT` constant + `showHelp(argv, HELP_TEXT)` first line of `main()`
- [ ] Uses `lib/api`, `lib/input`, `lib/log` as appropriate (not custom replacements)
- [ ] Banner, progress lines, summary block, exit code
- [ ] Rate-limit delay between iterations
- [ ] Registered in [cli.js](../../../cli.js) `commands` map
- [ ] Row added to README.md command table
- [ ] `node cli.js <name> --help` prints help and exits 0
