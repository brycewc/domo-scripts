/**
 * Bulk rename Domo datasets by searching for a substring and replacing it,
 * or by supplying explicit IDs and new names via a CSV file.
 *
 * Usage:
 *   node cli.js bulk-rename-datasets --search "Old Prefix" --replace "New Prefix"
 *   node cli.js bulk-rename-datasets --search "Old Prefix" --replace "New Prefix" --case-sensitive
 *   node cli.js bulk-rename-datasets --search "Old Prefix" --replace "New Prefix" --dry-run
 *   node cli.js bulk-rename-datasets --file renames.csv
 *
 * Options:
 *   --file, -f          CSV file with dataset IDs and new names (bypasses search/replace)
 *   --id-column         Column holding the dataset ID (default: "id")
 *   --name-column       Column holding the new name (default: "newName")
 *   --search, -s        Substring to find in dataset names (required unless --file)
 *   --replace, -r       Replacement string (required unless --file)
 *   --case-sensitive    Perform case-sensitive matching (default: false)
 *   --dry-run           Preview changes without applying them
 */

const { api, config, showHelp, createLogger, readCSV } = require('../lib');
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

const PAGE_SIZE = 100;

const HELP_TEXT = `Usage: node cli.js bulk-rename-datasets [options]

Bulk rename Domo datasets by searching for a substring and replacing it,
or by supplying explicit dataset IDs and new names via a CSV file.

Options:
  --file, -f         CSV file with dataset IDs and new names (bypasses search/replace)
  --id-column        Column holding the dataset ID (default: "id")
  --name-column      Column holding the new name (default: "newName")
  --search, -s       Substring to find in dataset names (required unless --file)
  --replace, -r      Replacement string (required unless --file)
  --case-sensitive   Perform case-sensitive matching (default: false)
  --dry-run          Preview changes without applying them

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

async function buildRenamesFromCSV(filePath, idColumn, nameColumn) {
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
		}

		await new Promise((r) => setTimeout(r, 150));
	}

	return renames;
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

async function main() {
	showHelp(argv, HELP_TEXT);

	const file = argv.file || argv.f;
	const idColumn = argv['id-column'] || 'id';
	const nameColumn = argv['name-column'] || 'newName';
	const searchStr = argv.search || argv.s;
	const replaceStr = argv.replace || argv.r;
	const caseSensitive = argv['case-sensitive'] || argv.c || false;
	const dryRun = argv['dry-run'] || argv.dry || false;

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

	const logger = createLogger('bulk-rename-datasets', {
		debugMode: false,
		dryRun
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
	if (file) {
		renames = await buildRenamesFromCSV(file, idColumn, nameColumn);
	} else {
		const matches = await findAllMatchingDatasources(searchStr, caseSensitive);

		if (matches.length === 0) {
			console.log('No datasources found containing the search string.');
			process.exit(0);
		}

		renames = matches.map((ds) => ({
			...ds,
			newName: buildNewName(ds.name, searchStr, replaceStr, caseSensitive)
		}));
	}

	if (renames.length === 0) {
		console.log('No datasets to rename.');
		process.exit(0);
	}

	const maxCurrentLen = Math.min(
		60,
		Math.max(...renames.map((r) => r.name.length))
	);

	console.log(`Found ${renames.length} dataset(s) to rename:\n`);
	console.log(
		`${'#'.padStart(4)}  ${'Current Name'.padEnd(maxCurrentLen)}  →  New Name`
	);
	console.log(
		`${''.padStart(4, '─')}  ${''.padEnd(maxCurrentLen, '─')}     ${''.padEnd(maxCurrentLen, '─')}`
	);

	for (let i = 0; i < renames.length; i++) {
		const { name, newName, id } = renames[i];
		const truncCurrent = name.length > 60 ? name.slice(0, 57) + '...' : name;
		console.log(
			`${String(i + 1).padStart(4)}  ${truncCurrent.padEnd(maxCurrentLen)}  →  ${newName}`
		);
		console.log(`${''.padStart(6)}ID: ${id}`);
	}

	console.log();

	if (dryRun) {
		console.log('Dry run complete. No changes were made.');
		for (const r of renames) {
			logger.addResult({
				datasetId: r.id,
				oldName: r.name,
				newName: r.newName,
				status: 'skipped'
			});
		}
		logger.writeRunLog({
			total: renames.length,
			renamed: 0,
			errors: 0
		});
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

	let successCount = 0;
	let errorCount = 0;

	for (let i = 0; i < renames.length; i++) {
		const { id, name, newName } = renames[i];
		console.log(`[${i + 1}/${renames.length}] "${name}" → "${newName}"`);

		try {
			await renameDatasource(id, newName, renames[i].description);
			console.log(
				`  ✓ Renamed: ${config.instanceUrl}/datasources/${id}/details/overview`
			);
			logger.addResult({
				datasetId: id,
				oldName: name,
				newName,
				status: 'renamed'
			});
			successCount++;
		} catch (error) {
			console.error(`  ✗ Error: ${error.message}`);
			logger.addResult({
				datasetId: id,
				oldName: name,
				newName,
				status: 'error',
				error: error.message
			});
			errorCount++;
		}

		if (i < renames.length - 1) {
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	console.log('\n=== Summary ===');
	console.log(`Total datasets:  ${renames.length}`);
	console.log(`Renamed:         ${successCount}`);
	console.log(`Errors:          ${errorCount}`);

	logger.writeRunLog({
		total: renames.length,
		renamed: successCount,
		errors: errorCount
	});

	if (errorCount > 0) {
		console.error(
			'\nSome datasets failed to rename. Check the error messages above.'
		);
		process.exit(1);
	} else {
		console.log('\nAll datasets renamed successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
