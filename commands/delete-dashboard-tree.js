/**
 * Delete a dashboard and every subdashboard beneath it
 *
 * Walks the page tree the same way export-dashboard-content does, then deletes
 * the pages deepest first, so a parent is only deleted once all of its
 * subpages are gone. Cards on the pages are not deleted.
 *
 * WARNING: This is a destructive operation. Deleted pages cannot be recovered.
 * Use --dry-run to preview the tree first, then --from-dry-run to delete
 * exactly that list without walking it again.
 *
 * Usage:
 *   node cli.js delete-dashboard-tree --page-id 2040411307 --dry-run
 *   node cli.js delete-dashboard-tree --from-dry-run
 *   node cli.js delete-dashboard-tree --page-ids "2040411307,1234567890"
 *   node cli.js delete-dashboard-tree --retry-errors
 *
 * Options:
 *   --page-id            Root page (dashboard) ID
 *   --page-ids           Comma-separated root page IDs
 *   --yes, -y            Skip the confirmation prompt
 *   --dry-run            List the pages that would be deleted without deleting
 *   --from-dry-run [file] Delete the pages a dry run found (default: latest dry run)
 *   --retry-errors [file] Retry the failed and unreached deletes of a run (default: latest run)
 *   --max-age <hours>    Allow a source log older than 24 hours
 */

const { api, config, confirmSource, createLogger, loadSource, printSource, showHelp } = require('../lib');
const argv = require('minimist')(process.argv.slice(2));

const COMMAND = 'delete-dashboard-tree';
const SELECTION_FLAGS = ['page-id', 'page-ids', 'dry-run'];

const HELP_TEXT = `Usage: node cli.js delete-dashboard-tree [options]

WARNING: This is a destructive operation.

Walks a dashboard and all of its subdashboards and deletes every page, deepest
first. Cards on the pages are left in place.

Root (one of):
  --page-id <id>         Page (dashboard) ID to start from
  --page-ids <ids>       Comma-separated page IDs, each walked as its own root

Optional:
  --yes, -y              Skip the confirmation prompt
  --dry-run              List the pages that would be deleted without deleting

Reusing an earlier run (skips the walk; the log's roots are reused):
  --from-dry-run [file]  Delete the pages a dry run found (default: the latest dry run log)
  --retry-errors [file]  Retry the failed and unreached deletes of a run (default: the latest run log)
  --max-age <hours>      Allow a source log older than 24 hours

Notes:
  - A page is never deleted while one of its subpages failed to delete in the
    same run; it is recorded as an error so --retry-errors picks it up.
  - If any page or subpage list cannot be read, nothing is deleted, since a
    missed subpage would otherwise be orphaned.`;

function parseIdList(value) {
	return value
		? String(value)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
}

/** Post-order, so every subpage comes before its parent. */
async function collectPages(pageId, parentId, depth, seen, out) {
	if (seen.has(String(pageId))) return;
	seen.add(String(pageId));

	const page = await api.get(`/content/v1/pages/${pageId}`);
	const childIds = (await api.get(`/content/v1/pages/${pageId}/subpages`)) || [];
	for (const childId of childIds) {
		await collectPages(childId, String(pageId), depth + 1, seen, out);
	}
	out.push({
		id: String(pageId),
		title: page.title || `Page ${pageId}`,
		parentId,
		depth
	});
}

function printTree(pages) {
	const byParent = new Map();
	const ids = new Set(pages.map((page) => page.id));
	for (const page of pages) {
		const key = page.parentId && ids.has(page.parentId) ? page.parentId : null;
		if (!byParent.has(key)) byParent.set(key, []);
		byParent.get(key).push(page);
	}
	function walk(parentId, indent) {
		for (const page of byParent.get(parentId) || []) {
			console.log(`${indent}${page.title} (${page.id})`);
			walk(page.id, `${indent}  `);
		}
	}
	walk(null, '  ');
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const source = loadSource(COMMAND, argv, {
		selectionFlags: SELECTION_FLAGS,
		toEntries: (row) =>
			row.id == null ? null : { id: row.id, title: row.title, parentId: row.parentId, depth: row.depth }
	});

	const rootIds = source
		? source.meta.rootPageIds || []
		: [...parseIdList(argv['page-id']), ...parseIdList(argv['page-ids'])];
	if (!source && rootIds.length === 0) {
		console.error('Error: --page-id or --page-ids is required\n');
		console.error(HELP_TEXT);
		process.exit(1);
	}
	const dryRun = argv['dry-run'] || false;

	const logger = createLogger(COMMAND, {
		debugMode: false,
		dryRun,
		source,
		runMeta: { rootPageIds: rootIds }
	});

	console.log('Delete Dashboard Tree');
	console.log('=====================\n');
	if (dryRun) console.log('*** DRY RUN: no pages will be deleted ***\n');
	console.log(`Instance:       ${config.instanceUrl}`);
	console.log(`Root page(s):   ${rootIds.join(', ')}\n`);

	let pages;
	if (source) {
		printSource(source);
		pages = source.entries;
	} else {
		console.log('Walking page tree...\n');
		pages = [];
		const seen = new Set();
		const discoverErrors = [];
		for (const rootId of rootIds) {
			try {
				await collectPages(rootId, null, 0, seen, pages);
			} catch (error) {
				console.error(`  ✗ Could not walk page ${rootId}: ${error.message}`);
				discoverErrors.push({ id: String(rootId), status: 'error', phase: 'discover', error: error.message });
			}
		}
		if (discoverErrors.length > 0) {
			for (const entry of discoverErrors) logger.addResult(entry);
			logger.writeRunLog({ total: pages.length, deleted: 0, notFound: 0, errors: discoverErrors.length });
			console.error('\nThe page tree could not be read in full, so nothing was deleted.');
			process.exit(1);
		}
	}

	if (pages.length === 0) {
		console.log(source ? 'The source log has nothing left to delete.' : 'No pages found.');
		logger.writeRunLog({ total: 0, deleted: 0, notFound: 0, errors: 0 });
		process.exit(0);
	}

	console.log(`${source ? 'To delete' : 'Found'} ${pages.length} page(s):\n`);
	printTree(pages);
	console.log();

	if (dryRun) {
		for (const page of pages) logger.addResult({ ...page, status: 'dry-run' });
		logger.writeRunLog({ total: pages.length, deleted: 0, notFound: 0, errors: 0 });
		console.log('Dry run complete. No pages were deleted.');
		console.log(`Run "node cli.js ${COMMAND} --from-dry-run" to delete exactly this list.`);
		process.exit(0);
	}

	if (!(await confirmSource(`Permanently delete ${pages.length} page(s)? (yes/no): `, argv))) {
		console.log('Aborted. No changes were made.');
		process.exit(0);
	}

	console.log();
	logger.beginExecution(pages, (page) => page.id);

	let deletedCount = 0;
	let notFoundCount = 0;
	let errorCount = 0;
	const failedIds = new Set();

	for (let i = 0; i < pages.length; i++) {
		const page = pages[i];
		console.log(`[${i + 1}/${pages.length}] ${page.title} (${page.id})`);

		const blockedBy = pages.find((other) => other.parentId === page.id && failedIds.has(other.id));
		if (blockedBy) {
			const message = `subpage ${blockedBy.id} was not deleted`;
			console.error(`  ✗ Skipped: ${message}`);
			logger.addResult({ ...page, status: 'error', error: message });
			failedIds.add(page.id);
			errorCount++;
			continue;
		}

		try {
			await api.del(`/content/v1/pages/${page.id}`);
			console.log('  ✓ Deleted');
			logger.addResult({ ...page, status: 'deleted' });
			deletedCount++;
		} catch (error) {
			if (error.status === 404) {
				console.log('  ↷ Already gone');
				logger.addResult({ ...page, status: 'not-found' });
				notFoundCount++;
			} else {
				console.error(`  ✗ Error: ${error.message}`);
				logger.addResult({ ...page, status: 'error', error: error.message });
				failedIds.add(page.id);
				errorCount++;
			}
		}

		if (i < pages.length - 1) await new Promise((r) => setTimeout(r, 150));
	}

	console.log('\n=== Summary ===');
	console.log(`Total:       ${pages.length}`);
	console.log(`Deleted:     ${deletedCount}`);
	console.log(`Not found:   ${notFoundCount}`);
	console.log(`Errors:      ${errorCount}`);

	logger.writeRunLog({ total: pages.length, deleted: deletedCount, notFound: notFoundCount, errors: errorCount });

	if (errorCount > 0) {
		console.error(`\nSome deletions failed. Run "node cli.js ${COMMAND} --retry-errors" to retry them.`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
