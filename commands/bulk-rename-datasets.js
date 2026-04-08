/**
 * Bulk rename Domo datasets by searching for a substring and replacing it
 *
 * Usage:
 *   node cli.js bulk-rename-datasets --search "Old Prefix" --replace "New Prefix"
 *   node cli.js bulk-rename-datasets --search "Old Prefix" --replace "New Prefix" --case-sensitive
 *   node cli.js bulk-rename-datasets --search "Old Prefix" --replace "New Prefix" --dry-run
 *
 * Options:
 *   --search, -s       Substring to find in dataset names (required)
 *   --replace, -r      Replacement string (required)
 *   --case-sensitive    Perform case-sensitive matching (default: false)
 *   --dry-run           Preview changes without applying them
 */

const api = require('../lib/api');
const { instanceUrl } = require('../lib/config');
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

const PAGE_SIZE = 100;

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
	const searchStr = argv.search || argv.s;
	const replaceStr = argv.replace || argv.r;
	const caseSensitive = argv['case-sensitive'] || argv.c || false;
	const dryRun = argv['dry-run'] || argv.dry || false;

	if (!searchStr || replaceStr === undefined) {
		console.error('Error: --search and --replace parameters are required\n');
		console.error('Usage:');
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

	console.log('Bulk Rename Datasets');
	console.log('====================\n');
	console.log(`Instance:       ${instanceUrl}`);
	console.log(`Search for:     "${searchStr}"`);
	console.log(`Replace with:   "${replaceStr}"`);
	console.log(`Case sensitive: ${caseSensitive}`);
	console.log(`Dry run:        ${dryRun}\n`);

	const matches = await findAllMatchingDatasources(searchStr, caseSensitive);

	if (matches.length === 0) {
		console.log('No datasources found containing the search string.');
		process.exit(0);
	}

	const renames = matches.map((ds) => ({
		...ds,
		newName: buildNewName(ds.name, searchStr, replaceStr, caseSensitive)
	}));

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
				`  ✓ Renamed: ${instanceUrl}/datasources/${id}/details/overview`
			);
			successCount++;
		} catch (error) {
			console.error(`  ✗ Error: ${error.message}`);
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
