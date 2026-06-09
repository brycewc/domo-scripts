/**
 * Find and delete beast modes (functions) that are not used in anything
 *
 * Searches /query/v1/functions/search for top-level (not nested), inactive
 * functions — i.e. beast modes with no active links to cards, views, etc. —
 * and deletes them in batches. Optionally restricted to one or more owners.
 * Variables are excluded unless --include-variables is passed.
 *
 * WARNING: This is a destructive operation. Deleted beast modes cannot be
 * recovered. Use --dry-run to preview what would be deleted first.
 *
 * Usage:
 *   node cli.js delete-unused-beast-modes --dry-run
 *   node cli.js delete-unused-beast-modes --owner 123456789
 *   node cli.js delete-unused-beast-modes --owner "123,456" --max 500
 *   node cli.js delete-unused-beast-modes --created-before "2024-01-01"
 *   node cli.js delete-unused-beast-modes --include-locked --include-variables
 *
 * Options:
 *   --owner, -o          Only delete beast modes owned by these user ID(s) (comma-separated)
 *   --created-before     Only delete beast modes created before this ISO date
 *                        (filtered client-side; the API has no created filter)
 *   --max, -m            Stop after finding this many beast modes to delete
 *   --batch-size, -b     Number of beast modes per bulk delete call (default: 50)
 *   --include-locked     Also delete locked beast modes (skipped by default)
 *   --include-variables  Also delete unused variables (excluded by default)
 *   --dry-run            Preview which beast modes would be deleted without deleting
 */

const { api, config, createLogger, showHelp } = require('../lib');
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

const PAGE_SIZE = 100;
const PREVIEW_LIMIT = 50;

const HELP_TEXT = `Usage: node cli.js delete-unused-beast-modes [options]

WARNING: This is a destructive operation.

Finds beast modes with no active links (not used in any card, view, etc.)
and deletes them after confirmation.

Options:
  --owner, -o          Only delete beast modes owned by these user ID(s) (comma-separated)
  --created-before     Only delete beast modes created before this ISO date (e.g. "2024-01-01")
  --max, -m            Stop after finding this many beast modes to delete
  --batch-size, -b     Beast modes per bulk delete call (default: 50)
  --include-locked     Also delete locked beast modes (skipped by default)
  --include-variables  Also delete unused variables (excluded by default)
  --dry-run            Preview without deleting`;

function ask(question) {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});
	return new Promise((resolve) =>
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase());
		})
	);
}

async function searchFunctions(ownerIds, includeVariables, limit, offset) {
	const filters = [{ field: 'notNested' }, { field: 'inactive', value: true }];
	if (!includeVariables) {
		filters.push({ field: 'notvariable' });
	}
	if (ownerIds.length > 0) {
		filters.push({ field: 'owner', idList: ownerIds });
	}
	// The sort is required — the API returns zero results without it.
	// Sorting by created ascending lets --created-before stop paginating
	// at the first result past the cutoff.
	return api.post('/query/v1/functions/search', {
		filters,
		sort: { field: 'created', ascending: true },
		limit,
		offset
	});
}

function activeLinkCount(fn) {
	return Object.values(fn.activeLinks || {}).reduce((sum, ids) => sum + ids.length, 0);
}

async function bulkDeleteFunctions(ids) {
	return api.post('/query/v1/functions/bulk/template', { delete: ids });
}

async function deleteSingleFunction(id) {
	return api.del(`/query/v1/functions/template/${id}`);
}

async function findUnusedBeastModes(ownerIds, includeVariables, includeLocked, createdBeforeMs, max) {
	const candidates = [];
	let lockedSkipped = 0;
	let offset = 0;

	while (true) {
		const result = await searchFunctions(ownerIds, includeVariables, PAGE_SIZE, offset);
		const functions = result.results || [];
		if (functions.length === 0) break;

		for (const fn of functions) {
			// The inactive filter should guarantee this, but deletion is
			// irreversible — never trust a beast mode that has active links.
			if (activeLinkCount(fn) > 0) continue;
			// The API has no created filter, so this one is client-side.
			// Results are sorted by created ascending, so the first result at
			// or past the cutoff means every remaining result is too — stop.
			if (createdBeforeMs) {
				if (typeof fn.created !== 'number') continue;
				if (fn.created >= createdBeforeMs) {
					return { candidates, lockedSkipped, totalHits: result.totalHits };
				}
			}
			if (fn.locked && !includeLocked) {
				lockedSkipped++;
				continue;
			}
			candidates.push({
				id: fn.id,
				name: fn.name,
				owner: fn.owner,
				created: fn.created
			});
			if (max && candidates.length >= max) {
				return { candidates, lockedSkipped, totalHits: result.totalHits };
			}
		}

		offset += PAGE_SIZE;
		if (!result.hasMore) break;
		process.stdout.write(`  Scanned ${offset} of ${result.totalHits} results...\r`);
		await new Promise((r) => setTimeout(r, 150));
	}

	return { candidates, lockedSkipped, totalHits: candidates.length };
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const ownerArg = argv.owner || argv.o;
	const ownerIds = ownerArg
		? String(ownerArg)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
	const max = parseInt(argv.max || argv.m || '0', 10) || 0;
	const batchSize = parseInt(argv['batch-size'] || argv.b || '50', 10);
	const includeLocked = argv['include-locked'] || false;
	const includeVariables = argv['include-variables'] || false;
	const dryRun = argv['dry-run'] || argv.dry || false;

	let createdBeforeMs = 0;
	if (argv['created-before']) {
		createdBeforeMs = Date.parse(argv['created-before']);
		if (isNaN(createdBeforeMs)) {
			console.error(
				`Error: --created-before must be an ISO date (e.g. "2024-01-01" or "2024-01-01T00:00:00Z"), got "${argv['created-before']}"`
			);
			process.exit(1);
		}
	}

	const logger = createLogger('delete-unused-beast-modes', {
		debugMode: false,
		dryRun,
		runMeta: {
			owners: ownerIds.length > 0 ? ownerIds : null,
			createdBefore: createdBeforeMs ? new Date(createdBeforeMs).toISOString() : null,
			max: max || null,
			batchSize,
			includeLocked,
			includeVariables
		}
	});

	console.log('Delete Unused Beast Modes');
	console.log('=========================\n');
	if (dryRun) {
		console.log('*** DRY RUN — no beast modes will be deleted ***\n');
	}
	console.log(`Instance:       ${config.instanceUrl}`);
	console.log(`Owner filter:   ${ownerIds.length > 0 ? ownerIds.join(', ') : '(none)'}`);
	console.log(`Created before: ${createdBeforeMs ? new Date(createdBeforeMs).toISOString() : '(any)'}`);
	console.log(`Max to delete:  ${max || '(no limit)'}`);
	console.log(`Batch size:     ${batchSize}`);
	console.log(`Locked:         ${includeLocked ? 'included' : 'skipped'}`);
	console.log(`Variables:      ${includeVariables ? 'included' : 'excluded'}\n`);

	console.log('Searching for unused beast modes...\n');
	const { candidates, lockedSkipped } = await findUnusedBeastModes(
		ownerIds,
		includeVariables,
		includeLocked,
		createdBeforeMs,
		max
	);

	if (lockedSkipped > 0) {
		console.log(`Skipped ${lockedSkipped} locked beast mode(s) (use --include-locked to delete them).`);
	}

	if (candidates.length === 0) {
		console.log('No unused beast modes found.');
		logger.writeRunLog({ total: 0, deleted: 0, errors: 0, lockedSkipped });
		process.exit(0);
	}

	console.log(`Found ${candidates.length} unused beast mode(s):\n`);
	for (const fn of candidates.slice(0, PREVIEW_LIMIT)) {
		console.log(`  ${String(fn.id).padEnd(10)} ${fn.name} (owner: ${fn.owner})`);
	}
	if (candidates.length > PREVIEW_LIMIT) {
		console.log(`  ... and ${candidates.length - PREVIEW_LIMIT} more (full list in the run log)`);
	}
	console.log();

	if (dryRun) {
		console.log('Dry run complete. No beast modes were deleted.');
		for (const fn of candidates) {
			logger.addResult({ ...fn, status: 'dry-run' });
		}
		logger.writeRunLog({
			total: candidates.length,
			deleted: 0,
			errors: 0,
			lockedSkipped
		});
		process.exit(0);
	}

	const answer = await ask(`Permanently delete ${candidates.length} beast mode(s)? (yes/no): `);
	if (answer !== 'yes' && answer !== 'y') {
		console.log('Aborted. No changes were made.');
		process.exit(0);
	}

	const totalBatches = Math.ceil(candidates.length / batchSize);
	console.log(`\nDeleting ${candidates.length} beast mode(s) in ${totalBatches} batch(es)...\n`);

	let successCount = 0;
	let errorCount = 0;

	for (let i = 0; i < candidates.length; i += batchSize) {
		const chunk = candidates.slice(i, i + batchSize);
		const batchNumber = Math.floor(i / batchSize) + 1;

		console.log(`[${batchNumber}/${totalBatches}] Deleting ${chunk.length} beast mode(s)...`);

		try {
			await bulkDeleteFunctions(chunk.map((fn) => fn.id));
			console.log(`  ✓ Batch ${batchNumber} succeeded`);
			for (const fn of chunk) {
				logger.addResult({ ...fn, status: 'deleted', batch: batchNumber });
			}
			successCount += chunk.length;
		} catch (error) {
			console.error(`  ✗ Batch ${batchNumber} failed: ${error.message}`);
			console.log(`  Retrying ${chunk.length} beast mode(s) individually...`);

			for (const fn of chunk) {
				try {
					await deleteSingleFunction(fn.id);
					console.log(`    ✓ "${fn.name}" (${fn.id}) deleted`);
					logger.addResult({
						...fn,
						status: 'deleted',
						batch: batchNumber,
						retried: true
					});
					successCount++;
				} catch (singleError) {
					console.error(`    ✗ "${fn.name}" (${fn.id}) failed: ${singleError.message}`);
					logger.addResult({
						...fn,
						status: 'error',
						error: singleError.message,
						batch: batchNumber
					});
					errorCount++;
				}
				await new Promise((r) => setTimeout(r, 150));
			}
		}

		if (i + batchSize < candidates.length) {
			await new Promise((r) => setTimeout(r, 150));
		}
	}

	console.log('\n=== Summary ===');
	console.log(`Total found: ${candidates.length}`);
	console.log(`Deleted:     ${successCount}`);
	console.log(`Errors:      ${errorCount}`);

	logger.writeRunLog({
		total: candidates.length,
		deleted: successCount,
		errors: errorCount,
		lockedSkipped
	});

	if (errorCount > 0) {
		console.error('\nSome deletions failed. Check the error messages above.');
		process.exit(1);
	} else {
		console.log('\nAll unused beast modes deleted successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
