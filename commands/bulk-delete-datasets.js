/**
 * Bulk delete Domo datasets from a CSV file or ID list
 *
 * WARNING: This is a destructive operation. Deleted datasets cannot be recovered.
 * Use --dry-run to preview which datasets would be deleted before committing.
 *
 * Usage:
 *   node cli.js bulk-delete-datasets --file "datasets.csv"
 *   node cli.js bulk-delete-datasets --file "datasets.csv" --column "My Column"
 *   node cli.js bulk-delete-datasets --file "datasets.csv" --dry-run
 *   node cli.js bulk-delete-datasets --file "datasets.csv" --batch-size 25
 *   node cli.js bulk-delete-datasets --dataset-id "00000000-0000-0000-0000-000000000000"
 *   node cli.js bulk-delete-datasets --dataset-ids "id1,id2,id3"
 *
 * Options:
 *   --file, -f     CSV file with dataset IDs
 *   --dataset-id   Single dataset ID (enables debug logging)
 *   --dataset-ids  Comma-separated dataset IDs
 *   --column, -c   CSV column name containing dataset IDs (default: "DataSet ID")
 *   --batch-size   Number of datasets per bulk API call (default: 50)
 *   --dry-run      Preview which datasets would be deleted without actually deleting
 */

const api = require('../lib/api');
const { resolveIds } = require('../lib/input');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-delete-datasets [options]

WARNING: This is a destructive operation.

Options:
  --file, -f     CSV file with dataset IDs
  --dataset-id   Single dataset ID
  --dataset-ids  Comma-separated dataset IDs
  --column, -c   CSV column with dataset IDs (default: "DataSet ID")
  --batch-size   Datasets per bulk API call (default: 50)
  --dry-run      Preview without deleting`;

async function bulkDeleteDatasets(ids) {
	return api.post('/data/v1/ui/bulk/delete', {
		ids,
		type: 'DATA_SOURCE'
	});
}

async function deleteSingleDataset(id) {
	return api.del(`/data/v3/datasources/${id}`);
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const batchSize = parseInt(argv['batch-size'] || argv.b || '50', 10);
	const dryRun = argv['dry-run'] || argv.dry || false;

	const { ids: datasetIds } = resolveIds(argv, {
		name: 'dataset',
		columnDefault: 'DataSet ID'
	});

	console.log('Bulk Delete Datasets');
	console.log('====================\n');
	if (dryRun) {
		console.log('*** DRY RUN — no datasets will be deleted ***\n');
	}
	console.log(`Batch Size: ${batchSize}`);
	console.log(`Datasets:   ${datasetIds.length}`);

	const totalBatches = Math.ceil(datasetIds.length / batchSize);
	console.log(
		`\nProcessing ${datasetIds.length} dataset(s) in ${totalBatches} batch(es)...\n`
	);

	if (dryRun) {
		for (let i = 0; i < datasetIds.length; i += batchSize) {
			const chunk = datasetIds.slice(i, i + batchSize);
			const batchNumber = Math.floor(i / batchSize) + 1;
			console.log(
				`[${batchNumber}/${totalBatches}] Would delete ${chunk.length} dataset(s): ${chunk.join(', ')}`
			);
		}

		console.log('\n=== Dry Run Summary ===');
		console.log(`Total datasets that would be deleted: ${datasetIds.length}`);
		console.log('\nRe-run without --dry-run to execute the deletion.');
		process.exit(0);
	}

	let successCount = 0;
	let errorCount = 0;

	for (let i = 0; i < datasetIds.length; i += batchSize) {
		const chunk = datasetIds.slice(i, i + batchSize);
		const batchNumber = Math.floor(i / batchSize) + 1;

		console.log(
			`[${batchNumber}/${totalBatches}] Deleting ${chunk.length} dataset(s)...`
		);

		try {
			await bulkDeleteDatasets(chunk);
			console.log(`  + Batch ${batchNumber} succeeded`);
			successCount += chunk.length;
		} catch (error) {
			console.error(`  x Batch ${batchNumber} failed: ${error.message}`);
			console.log(`  Retrying ${chunk.length} dataset(s) individually...`);

			for (const id of chunk) {
				try {
					await deleteSingleDataset(id);
					console.log(`    + Dataset ${id} deleted`);
					successCount++;
				} catch (singleError) {
					console.error(`    x Dataset ${id} failed: ${singleError.message}`);
					errorCount++;
				}
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
		}

		if (i + batchSize < datasetIds.length) {
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}

	console.log('\n=== Summary ===');
	console.log(`Total datasets: ${datasetIds.length}`);
	console.log(`Successfully deleted: ${successCount}`);
	console.log(`Errors: ${errorCount}`);

	if (errorCount > 0) {
		console.error('\nSome batches failed. Check the error messages above.');
		process.exit(1);
	} else {
		console.log('\nAll datasets deleted successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
