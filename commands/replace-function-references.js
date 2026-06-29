/**
 * Replace every reference to one beast mode / variable with another.
 *
 * Beast modes and variables are both "functions" on the Domo backend. A function
 * that nests another references it by numeric template id — `DOMO_BEAST_MODE(<id>)`
 * in the formula, and a `FUNCTION_TEMPLATE` entry in its links. This command finds
 * every function that uses --old-id (via the templateDependencies search), does a
 * full GET of each, rewrites the reference to --new-id in the formula and links,
 * and PUTs them back in batches via the bulk template endpoint. Domo re-derives the
 * dependency graph server-side from the rewritten formula, so nested references are
 * repointed automatically.
 *
 * WARNING: This rewrites live beast modes / variables. Use --dry-run to preview the
 * affected functions (and the rewritten payloads in the run log) before applying.
 *
 * Usage:
 *   node cli.js replace-function-references --old-id 412339 --new-id 516658 --dry-run
 *   node cli.js replace-function-references --old-id 412339 --new-id 516658
 *   node cli.js replace-function-references --old-id 412339 --new-id 516658 --batch-size 25 --yes
 *
 * Options:
 *   --old-id            ID of the beast mode / variable currently referenced (required)
 *   --new-id            ID of the beast mode / variable to reference instead (required)
 *   --batch-size, -b    Functions per bulk update call (default: 50)
 *   --yes, -y           Skip the confirmation prompt
 *   --dry-run           Preview the affected functions without writing
 */

const { api, config, createLogger, showHelp } = require('../lib');
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

const PAGE_SIZE = 100;

const HELP_TEXT = `Usage: node cli.js replace-function-references --old-id <id> --new-id <id> [options]

Replaces every reference to one beast mode / variable with another. Finds all
functions that nest --old-id, rewrites the reference to --new-id in their formula
and links, and saves them back in batches. Domo re-derives nesting server-side.

WARNING: This rewrites live beast modes / variables.

Options:
  --old-id          ID of the beast mode / variable currently referenced (required)
  --new-id          ID of the beast mode / variable to reference instead (required)
  --batch-size, -b  Functions per bulk update call (default: 50)
  --yes, -y         Skip the confirmation prompt
  --dry-run         Preview the affected functions without writing`;

function ask(question) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) =>
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase());
		})
	);
}

// Full function template, including expression + links (the fields we rewrite).
async function getTemplate(id) {
	return api.get(`/query/v1/functions/template/${id}?hidden=true`);
}

// Every function (beast mode or variable) that nests `oldId`, paged in full.
// Mirrors the screenshot's search: filter on templateDependencies. No notvariable
// filter, so both beast modes and variables that reference it come back.
async function findReferencingFunctions(oldId) {
	const found = [];
	let offset = 0;
	while (true) {
		const result = await api.post('/query/v1/functions/search', {
			name: '',
			filters: [{ field: 'templateDependencies', value: String(oldId) }],
			sort: { field: 'name', ascending: true },
			limit: PAGE_SIZE,
			offset
		});
		const functions = result.results || [];
		for (const fn of functions) {
			// A function can't reference itself, and the replacement shouldn't be
			// rewritten to point at itself either — skip both defensively.
			if (String(fn.id) === String(oldId) || String(fn.id) === String(argv['new-id'])) continue;
			found.push({ id: fn.id, name: fn.name || String(fn.id), variable: fn.variable === true });
		}
		offset += PAGE_SIZE;
		if (!result.hasMore || functions.length === 0) break;
		await new Promise((r) => setTimeout(r, 150));
	}
	return found;
}

/**
 * Rewrite a function template so every reference to `oldId` points at `newId`.
 * Returns the bulk-update entry, or null if nothing actually changed.
 *
 * Rewrites:
 *   - expression: `DOMO_BEAST_MODE(<oldId>)` -> `DOMO_BEAST_MODE(<newId>)`
 *   - links:      any FUNCTION_TEMPLATE link whose id is oldId -> newId
 *
 * Drops volatile metadata and `functionTemplateDependencies`: Domo derives nesting
 * server-side from the rewritten expression, and sending the dependency list makes
 * the bulk write reject a nested function (matches the Domo Toolkit's behavior).
 */
function buildUpdateEntry(template, oldId, newId) {
	const entry = JSON.parse(JSON.stringify(template));
	let changed = false;

	if (typeof entry.expression === 'string') {
		// Tolerate whitespace inside the parens: DOMO_BEAST_MODE( 412339 ).
		const re = new RegExp(`(DOMO_BEAST_MODE\\(\\s*)${oldId}(\\s*\\))`, 'g');
		const next = entry.expression.replace(re, `$1${newId}$2`);
		if (next !== entry.expression) {
			entry.expression = next;
			changed = true;
		}
	}

	if (Array.isArray(entry.links)) {
		for (const link of entry.links) {
			if (link?.resource?.type === 'FUNCTION_TEMPLATE' && String(link.resource.id) === String(oldId)) {
				link.resource.id = String(newId);
				changed = true;
			}
		}
	}

	if (!changed) return null;

	delete entry.checkSum;
	delete entry.created;
	delete entry.lastModified;
	delete entry.functionTemplateDependencies;
	return entry;
}

async function bulkUpdate(entries) {
	return api.post('/query/v1/functions/bulk/template', {
		update: entries,
		links: {},
		strict: false
	});
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const oldId = argv['old-id'];
	const newId = argv['new-id'];
	const batchSize = parseInt(argv['batch-size'] || argv.b || '50', 10);
	const dryRun = argv['dry-run'] || argv.dry || false;
	const skipConfirm = argv.yes || argv.y || false;

	if (oldId === undefined || newId === undefined) {
		console.error('Error: both --old-id and --new-id are required.\n');
		console.error(HELP_TEXT);
		process.exit(1);
	}
	if (String(oldId) === String(newId)) {
		console.error('Error: --old-id and --new-id are the same; nothing to replace.');
		process.exit(1);
	}

	const logger = createLogger('replace-function-references', {
		debugMode: false,
		dryRun,
		runMeta: { oldId, newId, batchSize }
	});

	console.log('Replace Function References');
	console.log('===========================\n');
	if (dryRun) console.log('*** DRY RUN — no functions will be modified ***\n');

	// Surface both endpoints' names / types. The old id may be a DELETED function —
	// those still come back from the dependency search even though the template GET
	// 404s — so tolerate its fetch failing and carry on. The new id must exist:
	// repointing to a missing function would break every dependent formula.
	let oldFn = null;
	let newFn;
	try {
		oldFn = await getTemplate(oldId);
	} catch (e) {
		console.log(`Note: could not load --old-id ${oldId} (${e.message}) — treating it as a deleted function.`);
	}
	try {
		newFn = await getTemplate(newId);
	} catch (e) {
		console.error(`Error: could not load --new-id ${newId}: ${e.message}`);
		process.exit(1);
	}

	const kind = (fn) => (fn.variable === true ? 'variable' : 'beast mode');
	console.log(`Instance: ${config.instanceUrl}`);
	console.log(
		oldFn
			? `Replace:  ${oldId}  "${oldFn.name}" (${kind(oldFn)}, ${oldFn.dataType || 'unknown type'})`
			: `Replace:  ${oldId}  (deleted / unavailable)`
	);
	console.log(`With:     ${newId}  "${newFn.name}" (${kind(newFn)}, ${newFn.dataType || 'unknown type'})\n`);

	if (oldFn && oldFn.dataType && newFn.dataType && oldFn.dataType !== newFn.dataType) {
		console.log(
			`WARNING: data types differ (${oldFn.dataType} -> ${newFn.dataType}). ` +
				'Formulas that depend on the old type may break.\n'
		);
	}

	console.log('Searching for functions that reference the old id...\n');
	const referencing = await findReferencingFunctions(oldId);

	if (referencing.length === 0) {
		console.log('No beast modes or variables reference that id. Nothing to do.');
		logger.writeRunLog({ total: 0, updated: 0, skipped: 0, errors: 0 });
		process.exit(0);
	}

	console.log(`Found ${referencing.length} function(s) referencing ${oldId}. Fetching full definitions...\n`);

	// Build the rewritten update entries up front so the dry-run preview and the
	// real write operate on exactly the same payloads.
	const entries = [];
	const skipped = [];
	let fetchErrors = 0;
	for (let i = 0; i < referencing.length; i++) {
		const fn = referencing[i];
		try {
			const template = await getTemplate(fn.id);
			const entry = buildUpdateEntry(template, oldId, newId);
			if (!entry) {
				console.log(`  - "${fn.name}" (${fn.id}): no reference found in formula/links, skipping`);
				skipped.push({ ...fn, status: 'skipped', reason: 'no reference in formula/links' });
				continue;
			}
			entries.push({ fn, entry });
		} catch (e) {
			console.error(`  ✗ "${fn.name}" (${fn.id}): failed to fetch — ${e.message}`);
			logger.addResult({ ...fn, status: 'error', error: `fetch failed: ${e.message}` });
			fetchErrors++;
		}
		if (i < referencing.length - 1) await new Promise((r) => setTimeout(r, 100));
	}

	for (const s of skipped) logger.addResult(s);

	console.log(`\n${entries.length} function(s) will be rewritten${skipped.length ? `, ${skipped.length} skipped` : ''}.\n`);
	for (const { fn } of entries) {
		console.log(`  ${String(fn.id).padEnd(10)} ${fn.name} (${fn.variable ? 'variable' : 'beast mode'})`);
	}
	console.log();

	if (entries.length === 0) {
		logger.writeRunLog({ total: referencing.length, updated: 0, skipped: skipped.length, errors: fetchErrors });
		process.exit(fetchErrors > 0 ? 1 : 0);
	}

	if (dryRun) {
		console.log('Dry run complete. No functions were modified.');
		for (const { fn, entry } of entries) {
			logger.addResult({ ...fn, status: 'dry-run', rewrittenExpression: entry.expression });
		}
		logger.writeRunLog({ total: referencing.length, updated: 0, skipped: skipped.length, errors: fetchErrors });
		process.exit(0);
	}

	if (!skipConfirm) {
		const answer = await ask(`Rewrite ${entries.length} function(s) to reference ${newId} instead of ${oldId}? (yes/no): `);
		if (answer !== 'yes' && answer !== 'y') {
			console.log('Aborted. No changes were made.');
			process.exit(0);
		}
	}

	const totalBatches = Math.ceil(entries.length / batchSize);
	console.log(`\nUpdating ${entries.length} function(s) in ${totalBatches} batch(es)...\n`);

	let successCount = 0;
	let errorCount = 0;

	for (let i = 0; i < entries.length; i += batchSize) {
		const chunk = entries.slice(i, i + batchSize);
		const batchNumber = Math.floor(i / batchSize) + 1;
		console.log(`[${batchNumber}/${totalBatches}] Updating ${chunk.length} function(s)...`);

		try {
			await bulkUpdate(chunk.map((c) => c.entry));
			console.log(`  ✓ Batch ${batchNumber} succeeded`);
			for (const { fn } of chunk) logger.addResult({ ...fn, status: 'updated', batch: batchNumber });
			successCount += chunk.length;
		} catch (error) {
			console.error(`  ✗ Batch ${batchNumber} failed: ${error.message}`);
			console.log(`  Retrying ${chunk.length} function(s) individually...`);
			for (const { fn, entry } of chunk) {
				try {
					await bulkUpdate([entry]);
					console.log(`    ✓ "${fn.name}" (${fn.id}) updated`);
					logger.addResult({ ...fn, status: 'updated', batch: batchNumber, retried: true });
					successCount++;
				} catch (singleError) {
					console.error(`    ✗ "${fn.name}" (${fn.id}) failed: ${singleError.message}`);
					logger.addResult({ ...fn, status: 'error', error: singleError.message, batch: batchNumber });
					errorCount++;
				}
				await new Promise((r) => setTimeout(r, 150));
			}
		}

		if (i + batchSize < entries.length) await new Promise((r) => setTimeout(r, 150));
	}

	console.log('\n=== Summary ===');
	console.log(`Referencing: ${referencing.length}`);
	console.log(`Updated:     ${successCount}`);
	console.log(`Skipped:     ${skipped.length}`);
	console.log(`Errors:      ${errorCount + fetchErrors}`);

	logger.writeRunLog({
		total: referencing.length,
		updated: successCount,
		skipped: skipped.length,
		errors: errorCount + fetchErrors
	});

	if (errorCount + fetchErrors > 0) {
		console.error('\nSome functions failed. Check the error messages above.');
		process.exit(1);
	} else {
		console.log('\nAll references replaced successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
