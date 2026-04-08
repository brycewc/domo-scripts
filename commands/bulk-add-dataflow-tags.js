/**
 * Bulk add Domo dataflow tags
 *
 * Two modes of operation:
 *   1) CSV file — reads dataflow IDs from a CSV column, then tags all of them
 *   2) Owner ID — fetches every dataflow owned by a user, then tags all of them
 *
 * Usage:
 *   node cli.js bulk-add-dataflow-tags --file "dataflows.csv" --tags "tag1,tag2"
 *   node cli.js bulk-add-dataflow-tags --file "dataflows.csv" --column "My Column" --tags "tag1,tag2"
 *   node cli.js bulk-add-dataflow-tags --owner-id "1234567890" --tags "tag1,tag2"
 *   node cli.js bulk-add-dataflow-tags --owner-id "1234567890" --tags "tag1,tag2" --batch-size 100
 *
 * Options:
 *   --file, -f    Path to a CSV file containing dataflow IDs
 *   --column, -c  CSV column name containing dataflow IDs (default: "DataFlow ID")
 *   --owner-id    Domo user ID whose owned dataflows will be tagged
 *   --tags, -t    Comma-separated list of tags to apply
 *   --batch-size  Number of dataflows per API call (default: 50)
 */

const api = require('../lib/api');
const { resolveIds } = require('../lib/input');
const argv = require('minimist')(process.argv.slice(2));

async function fetchDataflowIdsByOwner(ownerId) {
	const pageSize = 100;
	let offset = 0;
	const allIds = [];

	while (true) {
		const body = {
			entities: ['DATAFLOW'],
			filters: [
				{
					field: 'owned_by_id',
					filterType: 'term',
					value: ownerId
				}
			],
			query: '*',
			count: pageSize,
			offset
		};

		const result = await api.post('/search/v1/query', body);

		if (!result || !result.searchObjects || result.searchObjects.length === 0) {
			break;
		}

		const ids = result.searchObjects.map((obj) => obj.databaseId);
		allIds.push(...ids);

		if (result.searchObjects.length < pageSize) {
			break;
		}

		offset += pageSize;
		await new Promise((r) => setTimeout(r, 150));
	}

	return allIds;
}

async function bulkTagDataflows(ids, tags) {
	const body = {
		dataFlowIds: ids,
		tagNames: tags
	};

	return api.put('/dataprocessing/v1/dataflows/bulk/tag', body);
}

function printUsage() {
	console.log('Usage:');
	console.log(
		'  node cli.js bulk-add-dataflow-tags --file "dataflows.csv" --tags "tag1,tag2"'
	);
	console.log(
		'  node cli.js bulk-add-dataflow-tags --file "dataflows.csv" --column "My Column" --tags "tag1,tag2"'
	);
	console.log(
		'  node cli.js bulk-add-dataflow-tags --owner-id "1234567890" --tags "tag1,tag2"'
	);
	console.log(
		'  node cli.js bulk-add-dataflow-tags --owner-id "1234567890" --tags "tag1,tag2" --batch-size 100'
	);
	console.log('\nOptions:');
	console.log('  --file       Path to a CSV file containing dataflow IDs');
	console.log(
		'  --column     CSV column name containing dataflow IDs (default: "DataFlow ID")'
	);
	console.log(
		'  --owner-id   Domo user ID whose owned dataflows will be tagged'
	);
	console.log('  --tags       Comma-separated list of tags to apply');
	console.log('  --batch-size Number of dataflows per API call (default: 50)');
}

async function main() {
	if (argv.help || argv.h) {
		printUsage();
		process.exit(0);
	}

	const file = argv.file || argv.f;
	const ownerId = argv['owner-id'] || argv.o;
	const tagsRaw = argv.tags || argv.t;
	const batchSize = parseInt(argv['batch-size'] || argv.b || '50', 10);

	if (!file && !ownerId) {
		console.error('Error: Either --file or --owner-id is required\n');
		printUsage();
		process.exit(1);
	}

	if (file && ownerId) {
		console.error('Error: Specify --file or --owner-id, not both\n');
		printUsage();
		process.exit(1);
	}

	if (!tagsRaw) {
		console.error('Error: --tags parameter is required\n');
		printUsage();
		process.exit(1);
	}

	const tags = String(tagsRaw)
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);

	if (tags.length === 0) {
		console.error('Error: --tags must contain at least one non-empty tag');
		process.exit(1);
	}

	let dataflowIds = [];

	if (file) {
		const { ids } = resolveIds(argv, {
			name: 'dataflow',
			columnDefault: 'DataFlow ID'
		});
		dataflowIds = ids;

		console.log('Bulk Add DataFlow Tags');
		console.log('=========================\n');
		console.log(`Mode:       CSV file`);
		console.log(`File:       ${file}`);
		console.log(`Column:     ${argv.column || argv.c || 'DataFlow ID'}`);
	} else {
		console.log('Bulk Add DataFlow Tags');
		console.log('=========================\n');
		console.log(`Mode:       Owner lookup`);
		console.log(`Owner ID:   ${ownerId}`);

		console.log('\nFetching dataflows owned by user...');
		dataflowIds = await fetchDataflowIdsByOwner(ownerId);
	}

	if (dataflowIds.length === 0) {
		console.log('\nNo dataflows found. Nothing to do.');
		process.exit(0);
	}

	console.log(`Tags:       ${JSON.stringify(tags)}`);
	console.log(`Batch Size: ${batchSize}`);
	console.log(`DataFlows:  ${dataflowIds.length}`);

	const totalBatches = Math.ceil(dataflowIds.length / batchSize);
	console.log(
		`\nProcessing ${dataflowIds.length} dataflow(s) in ${totalBatches} batch(es)...\n`
	);

	let successCount = 0;
	let errorCount = 0;

	for (let i = 0; i < dataflowIds.length; i += batchSize) {
		const chunk = dataflowIds.slice(i, i + batchSize);
		const batchNumber = Math.floor(i / batchSize) + 1;

		console.log(
			`[${batchNumber}/${totalBatches}] Tagging ${chunk.length} dataflow(s)...`
		);

		try {
			await bulkTagDataflows(chunk, tags);
			console.log(`  ✓ Batch ${batchNumber} succeeded`);
			successCount += chunk.length;
		} catch (error) {
			console.error(`  ✗ Batch ${batchNumber} failed: ${error.message}`);
			errorCount += chunk.length;
		}

		if (i + batchSize < dataflowIds.length) {
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}

	console.log('\n=== Summary ===');
	console.log(`Total dataflows: ${dataflowIds.length}`);
	console.log(`Successfully tagged: ${successCount}`);
	console.log(`Errors: ${errorCount}`);

	if (errorCount > 0) {
		console.error('\nSome batches failed. Check the error messages above.');
		process.exit(1);
	} else {
		console.log('\nAll dataflows tagged successfully!');
	}
}

process.on('uncaughtException', (error) => {
	console.error('Error:', error.message);
	process.exit(1);
});

main();
