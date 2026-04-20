/**
 * Bulk rename Domo dataflows by searching for a substring and replacing it
 *
 * Usage:
 *   node cli.js bulk-rename-dataflows --search "Old Prefix" --replace "New Prefix"
 *   node cli.js bulk-rename-dataflows --search "Old Prefix" --replace "New Prefix" --case-sensitive
 *   node cli.js bulk-rename-dataflows --search "Old Prefix" --replace "New Prefix" --dry-run
 *
 * Options:
 *   --search, -s       Substring to find in dataflow names (required)
 *   --replace, -r      Replacement string (required)
 *   --case-sensitive    Perform case-sensitive matching (default: false)
 *   --dry-run           Preview changes without applying them
 */

const api = require('../lib/api');
const { instanceUrl } = require('../lib/config');
const { showHelp } = require('../lib/help');
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

const PAGE_SIZE = 100;

const HELP_TEXT = `Usage: node cli.js bulk-rename-dataflows [options]

Bulk rename Domo dataflows by searching for a substring and replacing it.

Options:
  --search, -s       Substring to find in dataflow names (required)
  --replace, -r      Replacement string (required)
  --case-sensitive   Perform case-sensitive matching (default: false)
  --dry-run          Preview changes without applying them`;

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

async function searchDataflows(query, count, offset) {
	return api.post('/search/v1/query', {
		entities: ['DATAFLOW'],
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

async function renameDataflow(dataflowId, newName) {
	return api.put(`/dataprocessing/v1/dataflows/${dataflowId}/patch`, {
		name: newName
	});
}

async function findAllMatchingDataflows(searchStr, caseSensitive) {
	const matches = [];
	let offset = 0;

	console.log(`Searching dataflows for "${searchStr}"...\n`);

	while (true) {
		const result = await searchDataflows(searchStr, PAGE_SIZE, offset);
		const dataflows =
			result.searchObjects || result.dataFlows || result.onboardFlows || [];

		if (dataflows.length === 0) break;

		for (const df of dataflows) {
			const name = df.name || '';
			const contains = caseSensitive
				? name.includes(searchStr)
				: name.toLowerCase().includes(searchStr.toLowerCase());

			if (contains) {
				matches.push({
					id: df.databaseId,
					name
				});
			}
		}

		const totalCount =
			result.totalCount ??
			result._metaData?.totalCount ??
			result.metaData?.totalCount ??
			0;
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

	const searchStr = argv.search || argv.s;
	const replaceStr = argv.replace || argv.r;
	const caseSensitive = argv['case-sensitive'] || argv.c || false;
	const dryRun = argv['dry-run'] || argv.dry || false;

	if (!searchStr || replaceStr === undefined) {
		console.error('Error: --search and --replace parameters are required\n');
		console.error('Usage:');
		console.error(
			'  node cli.js bulk-rename-dataflows --search "Old Text" --replace "New Text"'
		);
		console.error(
			'  node cli.js bulk-rename-dataflows --search "Old Text" --replace "New Text" --case-sensitive'
		);
		console.error(
			'  node cli.js bulk-rename-dataflows --search "Old Text" --replace "New Text" --dry-run'
		);
		process.exit(1);
	}

	console.log('Bulk Rename DataFlows');
	console.log('=====================\n');
	console.log(`Instance:       ${instanceUrl}`);
	console.log(`Search for:     "${searchStr}"`);
	console.log(`Replace with:   "${replaceStr}"`);
	console.log(`Case sensitive: ${caseSensitive}`);
	console.log(`Dry run:        ${dryRun}\n`);

	const matches = await findAllMatchingDataflows(searchStr, caseSensitive);

	if (matches.length === 0) {
		console.log('No dataflows found containing the search string.');
		process.exit(0);
	}

	const renames = matches.map((df) => ({
		...df,
		newName: buildNewName(df.name, searchStr, replaceStr, caseSensitive)
	}));

	const maxCurrentLen = Math.min(
		60,
		Math.max(...renames.map((r) => r.name.length))
	);

	console.log(`Found ${renames.length} dataflow(s) to rename:\n`);
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
		`Proceed with renaming ${renames.length} dataflow(s)? (yes/no): `
	);
	if (answer !== 'yes' && answer !== 'y') {
		console.log('Aborted. No changes were made.');
		process.exit(0);
	}

	console.log(`\nRenaming ${renames.length} dataflow(s)...\n`);

	let successCount = 0;
	let errorCount = 0;

	for (let i = 0; i < renames.length; i++) {
		const { id, name, newName } = renames[i];
		console.log(`[${i + 1}/${renames.length}] "${name}" → "${newName}"`);

		try {
			await renameDataflow(id, newName);
			console.log(
				`  ✓ Renamed: ${instanceUrl}/datacenter/dataflows/${id}/details`
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
	console.log(`Total dataflows: ${renames.length}`);
	console.log(`Renamed:         ${successCount}`);
	console.log(`Errors:          ${errorCount}`);

	if (errorCount > 0) {
		console.error(
			'\nSome dataflows failed to rename. Check the error messages above.'
		);
		process.exit(1);
	} else {
		console.log('\nAll dataflows renamed successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
