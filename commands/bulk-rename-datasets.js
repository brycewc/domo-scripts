/**
 * Bulk rename Domo datasets by searching for a substring and replacing it,
 * or by supplying explicit IDs and new names via a CSV file.
 *
 * Usage:
 *   node cli.js bulk-rename-datasets --search "Old Prefix" --replace "New Prefix"
 *   node cli.js bulk-rename-datasets --search "Old Prefix" --replace "New Prefix" --case-sensitive
 *   node cli.js bulk-rename-datasets --search "Old Prefix" --replace "New Prefix" --dry-run
 *   node cli.js bulk-rename-datasets --file renames.csv
 *   node cli.js bulk-rename-datasets --from-dry-run
 *   node cli.js bulk-rename-datasets --retry-errors
 *
 * --from-dry-run and --retry-errors skip the search / CSV lookups, re-fetch each
 * dataset, and skip it if its name no longer matches the logged old name.
 *
 * Options:
 *   --file, -f             CSV file with dataset IDs and new names (bypasses search/replace)
 *   --id-column            Column holding the dataset ID (default: "id")
 *   --name-column          Column holding the new name (default: "newName")
 *   --search, -s           Substring to find in dataset names (required unless --file)
 *   --replace, -r          Replacement string (required unless --file)
 *   --case-sensitive       Perform case-sensitive matching (default: false)
 *   --dry-run              Preview changes without applying them
 *   --from-dry-run [file]  Run exactly what a dry run planned (default: the latest dry run log)
 *   --retry-errors [file]  Retry the failed and unreached items of a run (default: the latest run log)
 *   --max-age <hours>      Allow a source log older than 24 hours
 */

const { api, config, showHelp, createLogger, loadSource, printSource, readCSV } = require('../lib');
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

const COMMAND = 'bulk-rename-datasets';
const PAGE_SIZE = 100;
const SELECTION_FLAGS = [
	'file',
	'f',
	'id-column',
	'name-column',
	'search',
	's',
	'replace',
	'r',
	'case-sensitive',
	'c',
	'dry-run',
	'dry'
];

const HELP_TEXT = `Usage: node cli.js bulk-rename-datasets [options]

Bulk rename Domo datasets by searching for a substring and replacing it,
or by supplying explicit dataset IDs and new names via a CSV file.

Options:
  --file, -f             CSV file with dataset IDs and new names (bypasses search/replace)
  --id-column            Column holding the dataset ID (default: "id")
  --name-column          Column holding the new name (default: "newName")
  --search, -s           Substring to find in dataset names (required unless --file)
  --replace, -r          Replacement string (required unless --file)
  --case-sensitive       Perform case-sensitive matching (default: false)
  --dry-run              Preview changes without applying them

Reusing an earlier run (skips the search; each dataset is re-checked before renaming):
  --from-dry-run [file]  Run exactly what a dry run planned (default: the latest dry run log)
  --retry-errors [file]  Retry the failed and unreached items of a run (default: the latest run log)
  --max-age <hours>      Allow a source log older than 24 hours

CSV mode reads one row per dataset. Only the ID and new-name columns are used;
all other search/replace options are ignored.`;

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

async function searchDatasources(query, count, offset) {
	return api.post('/data/ui/v3/datasources/search', {
		entities: ['DATASET'],
		filters: [
			{
				field: 'name_sort',
				filterType: 'wildcard',
				query: `*${query}*`
			}
		],
		combineResults: true,
		query: query,
		count,
		offset,
		sort: {
			isRelevance: false,
			fieldSorts: [{ field: 'name_sort', sortOrder: 'ASC' }]
		}
	});
}

async function renameDatasource(datasetId, newName, description) {
	return api.put(`/data/v3/datasources/${datasetId}/properties`, {
		dataSourceName: newName,
		dataSourceDescription: description
	});
}

async function getDatasource(datasetId) {
	return api.get(`/data/v3/datasources/${datasetId}`);
}

async function buildRenamesFromCSV(filePath, idColumn, nameColumn, logger) {
	const rows = readCSV(filePath);
	const available = Object.keys(rows[0]);

	for (const col of [idColumn, nameColumn]) {
		if (!available.includes(col)) {
			throw new Error(
				`Column "${col}" not found in CSV. Available columns: ${available.join(', ')}`
			);
		}
	}

	const renames = [];
	let errors = 0;
	console.log(`Fetching current details for ${rows.length} dataset(s)...\n`);

	for (let i = 0; i < rows.length; i++) {
		const id = String(rows[i][idColumn] || '').trim();
		const newName = String(rows[i][nameColumn] || '').trim();

		if (!id || !newName) {
			console.warn(
				`  Skipping row ${i + 1}: missing ${!id ? idColumn : nameColumn}`
			);
			continue;
		}

		try {
			const ds = await getDatasource(id);
			renames.push({
				id,
				name: ds.name || '',
				description: ds.description ?? '',
				newName
			});
		} catch (error) {
			console.warn(`  Skipping ${id}: ${error.message}`);
			logger.addResult({ datasetId: id, newName, status: 'error', phase: 'discover', error: error.message });
			errors++;
		}

		await new Promise((r) => setTimeout(r, 150));
	}

	return { renames, errors };
}

async function findAllMatchingDatasources(searchStr, caseSensitive) {
	const matches = [];
	let offset = 0;

	console.log(`Searching datasources for "${searchStr}"...\n`);

	while (true) {
		const result = await searchDatasources(searchStr, PAGE_SIZE, offset);
		const dataSources = result.dataSources || [];

		if (dataSources.length === 0) break;

		for (const ds of dataSources) {
			const name = ds.name || '';
			const contains = caseSensitive
				? name.includes(searchStr)
				: name.toLowerCase().includes(searchStr.toLowerCase());

			if (contains) {
				matches.push({
					id: ds.id,
					name,
					description: ds.description ?? ''
				});
			}
		}

		const totalCount = result._metaData?.totalCount || 0;
		offset += PAGE_SIZE;
		if (offset >= totalCount) break;
		process.stdout.write(`  Scanned ${offset} of ${totalCount} results...\r`);
		await new Promise((r) => setTimeout(r, 150));
	}

	return matches;
}

function buildNewName(originalName, searchStr, replaceStr, caseSensitive) {
	if (caseSensitive) {
		return originalName.split(searchStr).join(replaceStr);
	}
	const regex = new RegExp(
		searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
		'gi'
	);
	return originalName.replace(regex, replaceStr);
}

function toEntry(row) {
	if (row.datasetId == null || row.oldName == null || !row.newName) return null;
	return { datasetId: row.datasetId, oldName: row.oldName, newName: row.newName };
}

function parseSelection() {
	const file = argv.file || argv.f;
	const searchStr = argv.search || argv.s;
	const replaceStr = argv.replace || argv.r;

	if (!file && (!searchStr || replaceStr === undefined)) {
		console.error(
			'Error: provide either --file, or both --search and --replace\n'
		);
		console.error('Usage:');
		console.error('  node cli.js bulk-rename-datasets --file renames.csv');
		console.error(
			'  node cli.js bulk-rename-datasets --search "Old Text" --replace "New Text"'
		);
		console.error(
			'  node cli.js bulk-rename-datasets --search "Old Text" --replace "New Text" --case-sensitive'
		);
		console.error(
			'  node cli.js bulk-rename-datasets --search "Old Text" --replace "New Text" --dry-run'
		);
		process.exit(1);
	}

	if (file) {
		return {
			file,
			idColumn: argv['id-column'] || 'id',
			nameColumn: argv['name-column'] || 'newName'
		};
	}
	return {
		search: String(searchStr),
		replace: String(replaceStr),
		caseSensitive: Boolean(argv['case-sensitive'] || argv.c)
	};
}

function selectionFromMeta(meta) {
	if (meta.file) {
		return { file: meta.file, idColumn: meta.idColumn, nameColumn: meta.nameColumn };
	}
	return { search: meta.search, replace: meta.replace, caseSensitive: Boolean(meta.caseSensitive) };
}

// Source mode re-reads the dataset so the rename carries its current description.
async function checkCurrent(entry) {
	const ds = await getDatasource(entry.datasetId);
	const currentName = ds.name || '';
	if (currentName !== entry.oldName) return { skipReason: currentName };
	return { description: ds.description ?? '' };
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const source = loadSource(COMMAND, argv, { selectionFlags: SELECTION_FLAGS, toEntries: toEntry });
	const selection = source ? selectionFromMeta(source.meta) : parseSelection();
	const { file, idColumn, nameColumn, search: searchStr, replace: replaceStr, caseSensitive } = selection;
	const dryRun = argv['dry-run'] || argv.dry || false;

	const logger = createLogger(COMMAND, {
		debugMode: false,
		dryRun,
		source,
		runMeta: selection
	});

	console.log('Bulk Rename Datasets');
	console.log('====================\n');
	console.log(`Instance:       ${config.instanceUrl}`);
	if (file) {
		console.log(`File:           ${file}`);
		console.log(`ID column:      "${idColumn}"`);
		console.log(`Name column:    "${nameColumn}"`);
	} else {
		console.log(`Search for:     "${searchStr}"`);
		console.log(`Replace with:   "${replaceStr}"`);
		console.log(`Case sensitive: ${caseSensitive}`);
	}
	console.log(`Dry run:        ${dryRun}\n`);

	let renames;
	const descriptions = new Map();
	let discoverErrors = 0;
	if (source) {
		printSource(source);
		renames = source.entries;
	} else {
		let found;
		if (file) {
			({ renames: found, errors: discoverErrors } = await buildRenamesFromCSV(file, idColumn, nameColumn, logger));
		} else {
			const matches = await findAllMatchingDatasources(searchStr, caseSensitive);
			found = matches.map((ds) => ({
				...ds,
				newName: buildNewName(ds.name, searchStr, replaceStr, caseSensitive)
			}));
		}
		renames = found.map((r) => {
			descriptions.set(r.id, r.description);
			return { datasetId: r.id, oldName: r.name, newName: r.newName };
		});
	}

	if (renames.length === 0) {
		console.log(source ? 'The source log has nothing left to rename.' : 'No datasets to rename.');
		logger.writeRunLog({ total: 0, renamed: 0, skipped: 0, errors: discoverErrors });
		process.exit(discoverErrors > 0 ? 1 : 0);
	}

	const maxCurrentLen = Math.min(
		60,
		Math.max(...renames.map((r) => r.oldName.length))
	);

	console.log(`${source ? 'Planned' : 'Found'} ${renames.length} dataset(s) to rename:\n`);
	console.log(
		`${'#'.padStart(4)}  ${'Current Name'.padEnd(maxCurrentLen)}  →  New Name`
	);
	console.log(
		`${''.padStart(4, '─')}  ${''.padEnd(maxCurrentLen, '─')}     ${''.padEnd(maxCurrentLen, '─')}`
	);

	for (let i = 0; i < renames.length; i++) {
		const { oldName, newName, datasetId } = renames[i];
		const truncCurrent = oldName.length > 60 ? oldName.slice(0, 57) + '...' : oldName;
		console.log(
			`${String(i + 1).padStart(4)}  ${truncCurrent.padEnd(maxCurrentLen)}  →  ${newName}`
		);
		console.log(`${''.padStart(6)}ID: ${datasetId}`);
	}

	console.log();

	if (dryRun) {
		console.log('Dry run complete. No changes were made.');
		for (const r of renames) {
			logger.addResult({ ...r, status: 'dry-run' });
		}
		logger.writeRunLog({
			total: renames.length,
			renamed: 0,
			skipped: 0,
			errors: discoverErrors
		});
		console.log(`Run "node cli.js ${COMMAND} --from-dry-run" to apply this plan.`);
		process.exit(0);
	}

	const answer = await ask(
		`Proceed with renaming ${renames.length} dataset(s)? (yes/no): `
	);
	if (answer !== 'yes' && answer !== 'y') {
		console.log('Aborted. No changes were made.');
		process.exit(0);
	}

	console.log(`\nRenaming ${renames.length} dataset(s)...\n`);
	logger.beginExecution(renames, (row) => String(row.datasetId));

	let successCount = 0;
	let skipCount = 0;
	let errorCount = 0;

	for (let i = 0; i < renames.length; i++) {
		const entry = renames[i];
		const { datasetId, oldName, newName } = entry;
		console.log(`[${i + 1}/${renames.length}] "${oldName}" → "${newName}"`);

		try {
			let description = descriptions.get(datasetId);
			if (source) {
				const current = await checkCurrent(entry);
				if (current.skipReason !== undefined) {
					console.log(`  Skipped: the name is now "${current.skipReason}"`);
					logger.addResult({ ...entry, status: 'skipped', reason: 'name-changed' });
					skipCount++;
					continue;
				}
				description = current.description;
			}
			await renameDatasource(datasetId, newName, description);
			console.log(
				`  ✓ Renamed: ${config.instanceUrl}/datasources/${datasetId}/details/overview`
			);
			logger.addResult({ ...entry, status: 'renamed' });
			successCount++;
		} catch (error) {
			console.error(`  ✗ Error: ${error.message}`);
			logger.addResult({ ...entry, status: 'error', error: error.message });
			errorCount++;
		}

		if (i < renames.length - 1) {
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	console.log('\n=== Summary ===');
	console.log(`Total datasets:  ${renames.length}`);
	console.log(`Renamed:         ${successCount}`);
	if (skipCount > 0) console.log(`Skipped:         ${skipCount} (name changed since the log)`);
	console.log(`Errors:          ${errorCount + discoverErrors}`);

	logger.writeRunLog({
		total: renames.length,
		renamed: successCount,
		skipped: skipCount,
		errors: errorCount + discoverErrors
	});

	if (errorCount > 0) {
		console.error(
			`\nSome datasets failed to rename. Run "node cli.js ${COMMAND} --retry-errors" to retry them.`
		);
		process.exit(1);
	} else if (discoverErrors > 0) {
		console.error('\nSome CSV rows could not be looked up. Check the messages above.');
		process.exit(1);
	} else {
		console.log('\nAll datasets renamed successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
