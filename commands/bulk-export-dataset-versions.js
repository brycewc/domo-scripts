/**
 * Export all dataset versions to a CSV file
 *
 * Fetches successive data versions from a dataset, concatenating them into a
 * single output CSV. Stops when a version returns a non-OK response.
 *
 * Usage:
 *   node cli.js bulk-export-dataset-versions --dataset-id "00000000-0000-0000-0000-000000000000"
 *   node cli.js bulk-export-dataset-versions --dataset-id "00000000-0000-0000-0000-000000000000" --start-version-id 5
 *
 * Options:
 *   --dataset-id        DataSet ID to export versions from (required)
 *   --start-version-id  Version number to start from (default: 1)
 */

const { baseUrl, accessToken, requireAuth } = require('../lib/config');
const { showHelp } = require('../lib/help');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage:
  node cli.js bulk-export-dataset-versions --dataset-id "00000000-0000-0000-0000-000000000000"
  node cli.js bulk-export-dataset-versions --dataset-id "00000000-0000-0000-0000-000000000000" --start-version-id 5

Options:
  --dataset-id        DataSet ID to export versions from (required)
  --start-version-id  Version number to start from (default: 1)`;

showHelp(argv, HELP_TEXT);
requireAuth();

async function getDataVersion(datasetId, versionId) {
	const url = `${baseUrl}/data/v2/datasources/${datasetId}/dataversions/${versionId}?excludeAppendedData=true&rowLimit=1000000`;

	const options = {
		method: 'GET',
		headers: {
			'X-DOMO-Developer-Token': accessToken,
			Accept: 'text/csv'
		}
	};

	try {
		const response = await fetch(url, options);

		if (!response.ok) {
			return { success: false, status: response.status };
		}

		const csvData = await response.text();
		return { success: true, data: csvData };
	} catch (error) {
		throw new Error(`Failed to fetch version ${versionId}: ${error.message}`);
	}
}

async function main() {
	const datasetId = argv['dataset-id'];
	let startVersionId = parseInt(argv['start-version-id'], 10) || 1;

	if (!datasetId) {
		console.error('Error: --dataset-id parameter is required\n');
		console.error(HELP_TEXT);
		process.exit(1);
	}

	// Create output filename with timestamp
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const outputFile = `dataset_${datasetId}_export_${timestamp}.csv`;

	console.log(`Exporting dataset ${datasetId} versions to ${outputFile}...\n`);

	let versionId = startVersionId;
	let successCount = 0;
	let isFirstVersion = true;

	try {
		while (true) {
			console.log(`Fetching version ${versionId}...`);

			const result = await getDataVersion(datasetId, versionId);

			if (!result.success) {
				console.log(
					`Version ${versionId} not found (HTTP ${result.status}). Stopping.\n`
				);
				break;
			}

			const csvData = result.data;

			// For first version, write everything (including headers)
			// For subsequent versions, skip the header row
			if (isFirstVersion) {
				fs.writeFileSync(outputFile, csvData);
				isFirstVersion = false;
			} else {
				const lines = csvData.split(/\r?\n/).filter(Boolean);
				if (lines.length > 1) {
					// Skip header row and append remaining data
					const dataRows = lines.slice(1).join('\n');
					fs.appendFileSync(outputFile, '\n' + dataRows);
				}
			}

			console.log(`  Version ${versionId} appended\n`);
			successCount++;
			versionId++;

			// Small delay to avoid overwhelming the API
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		// Summary
		console.log('=== Summary ===');
		console.log(`Dataset ID: ${datasetId}`);
		console.log(`Versions exported: ${successCount}`);
		console.log(`Output file: ${outputFile}`);
		console.log('\nExport completed successfully!');
	} catch (error) {
		console.error(`Error: ${error.message}`);
		process.exit(1);
	}
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
	console.error('Error:', error.message);
	process.exit(1);
});

main();
