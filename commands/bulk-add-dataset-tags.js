/**
 * Bulk add Domo dataset tags
 *
 * Two modes of operation:
 *   1) CSV file — reads dataset IDs from a CSV column, then tags all of them
 *   2) Owner ID — fetches every dataset owned by a user, then tags all of them
 *
 * Usage:
 *   node cli.js bulk-add-dataset-tags --file "datasets.csv" --tags "tag1,tag2"
 *   node cli.js bulk-add-dataset-tags --file "datasets.csv" --column "My Column" --tags "tag1,tag2"
 *   node cli.js bulk-add-dataset-tags --owner-id "1234567890" --tags "tag1,tag2"
 *   node cli.js bulk-add-dataset-tags --owner-id "1234567890" --tags "tag1,tag2" --batch-size 100
 *
 * Options:
 *   --file, -f    Path to a CSV file containing dataset IDs
 *   --column, -c  CSV column name containing dataset IDs (default: "DataSet ID")
 *   --owner-id    Domo user ID whose owned datasets will be tagged
 *   --tags, -t    Comma-separated list of tags to apply
 *   --batch-size  Number of datasets per API call (default: 50)
 */

const api = require('../lib/api');
const { resolveIds } = require('../lib/input');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage:
  node cli.js bulk-add-dataset-tags --file "datasets.csv" --tags "tag1,tag2"
  node cli.js bulk-add-dataset-tags --file "datasets.csv" --column "My Column" --tags "tag1,tag2"
  node cli.js bulk-add-dataset-tags --owner-id "1234567890" --tags "tag1,tag2"
  node cli.js bulk-add-dataset-tags --owner-id "1234567890" --tags "tag1,tag2" --batch-size 100

Options:
  --file       Path to a CSV file containing dataset IDs
  --column     CSV column name containing dataset IDs (default: "DataSet ID")
  --owner-id   Domo user ID whose owned datasets will be tagged
  --tags       Comma-separated list of tags to apply
  --batch-size Number of datasets per API call (default: 50)`;

async function fetchDatasetIdsByOwner(ownerId) {
	const body = [{ id: ownerId.toString(), type: 'USER' }];

	const result = await api.post('/data/ui/v3/datasources/ownedBy', body);

	if (result && result.length > 0 && result[0].dataSourceIds) {
		return result[0].dataSourceIds;
	}
	return [];
}

async function bulkTagDatasets(ids, tags) {
	const body = {
		bulkItems: {
			ids,
			type: 'DATA_SOURCE'
		},
		tags
	};

	return api.post('/data/v1/ui/bulk/tag', body);
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const file = argv.file || argv.f;
	const ownerId = argv['owner-id'] || argv.o;
	const tagsRaw = argv.tags || argv.t;
	const batchSize = parseInt(argv['batch-size'] || argv.b || '50', 10);

	if (!file && !ownerId) {
		console.error('Error: Either --file or --owner-id is required\n');
		console.error(HELP_TEXT);
		process.exit(1);
	}

	if (file && ownerId) {
		console.error('Error: Specify --file or --owner-id, not both\n');
		console.error(HELP_TEXT);
		process.exit(1);
	}

	if (!tagsRaw) {
		console.error('Error: --tags parameter is required\n');
		console.error(HELP_TEXT);
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

	let datasetIds = [];

	if (file) {
		const { ids } = resolveIds(argv, {
			name: 'dataset',
			columnDefault: 'DataSet ID'
		});
		datasetIds = ids;

		console.log('Bulk Add Dataset Tags');
		console.log('========================\n');
		console.log(`Mode:       CSV file`);
		console.log(`File:       ${file}`);
		console.log(`Column:     ${argv.column || argv.c || 'DataSet ID'}`);
	} else {
		console.log('Bulk Add Dataset Tags');
		console.log('========================\n');
		console.log(`Mode:       Owner lookup`);
		console.log(`Owner ID:   ${ownerId}`);

		console.log('\nFetching datasets owned by user...');
		datasetIds = await fetchDatasetIdsByOwner(ownerId);
	}

	if (datasetIds.length === 0) {
		console.log('\nNo datasets found. Nothing to do.');
		process.exit(0);
	}

	console.log(`Tags:       ${JSON.stringify(tags)}`);
	console.log(`Batch Size: ${batchSize}`);
	console.log(`Datasets:   ${datasetIds.length}`);

	const totalBatches = Math.ceil(datasetIds.length / batchSize);
	console.log(
		`\nProcessing ${datasetIds.length} dataset(s) in ${totalBatches} batch(es)...\n`
	);

	let successCount = 0;
	let errorCount = 0;

	for (let i = 0; i < datasetIds.length; i += batchSize) {
		const chunk = datasetIds.slice(i, i + batchSize);
		const batchNumber = Math.floor(i / batchSize) + 1;

		console.log(
			`[${batchNumber}/${totalBatches}] Tagging ${chunk.length} dataset(s)...`
		);

		try {
			await bulkTagDatasets(chunk, tags);
			console.log(`  ✓ Batch ${batchNumber} succeeded`);
			successCount += chunk.length;
		} catch (error) {
			console.error(`  ✗ Batch ${batchNumber} failed: ${error.message}`);
			errorCount += chunk.length;
		}

		if (i + batchSize < datasetIds.length) {
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}

	console.log('\n=== Summary ===');
	console.log(`Total datasets: ${datasetIds.length}`);
	console.log(`Successfully tagged: ${successCount}`);
	console.log(`Errors: ${errorCount}`);

	if (errorCount > 0) {
		console.error('\nSome batches failed. Check the error messages above.');
		process.exit(1);
	} else {
		console.log('\nAll datasets tagged successfully!');
	}
}

process.on('uncaughtException', (error) => {
	console.error('Error:', error.message);
	process.exit(1);
});

main();
