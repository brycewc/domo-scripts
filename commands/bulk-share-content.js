/**
 * Share content in bulk using a CSV or JSON file of content IDs
 *
 * Usage:
 *   node cli.js bulk-share-content --file "content.csv" --user "1250228141"
 *   node cli.js bulk-share-content --file "content.csv" --group "12345"
 *   node cli.js bulk-share-content --file "card-ids.json" --user "1250228141" --content-type "card"
 *   node cli.js bulk-share-content --file "badge-ids.json" --group "12345" --content-type "badge"
 *   node cli.js bulk-share-content --file "dataset-ids.json" --user "1250228141" --content-type "dataset" --access-level "CAN_VIEW"
 *
 * Options:
 *   --file             CSV or JSON file with content IDs (required)
 *   --user             User ID to share with (required if --group not set)
 *   --group            Group ID to share with (required if --user not set)
 *   --content-type     Content type for JSON files: card, badge, page, dataApp, alert, dataset (required for JSON)
 *   --access-level     Access level for dataset sharing: CAN_VIEW, CAN_SHARE, CAN_EDIT, OWNER (default: CAN_VIEW)
 *
 * CSV format: Must have "Object ID" and "Object Type ID" columns. Use "DATA_SOURCE" for datasets.
 * JSON format: Must be an array of integers. Requires --content-type.
 *
 * Datasets are shared in bulk via /data/v1/ui/bulk/share (batched with the other content types).
 * All other content types are batched through /content/v1/share.
 */

const api = require('../lib/api');
const { readCSV } = require('../lib/csv');
const { showHelp } = require('../lib/help');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-share-content [options]

Share content in bulk using a CSV or JSON file of content IDs.

Options:
  --file           CSV or JSON file with content IDs (required)
  --user           User ID to share with (required if --group not set)
  --group          Group ID to share with (required if --user not set)
  --content-type   Content type for JSON files: card, badge, page, dataApp, alert, dataset
                   (required for JSON files)
  --access-level   Access level for dataset sharing: CAN_VIEW, CAN_SHARE, CAN_EDIT, OWNER
                   (default: CAN_VIEW)

CSV format: Must have "Object ID" and "Object Type ID" columns. Use "DATA_SOURCE" for datasets.
JSON format: Must be an array of integers. Requires --content-type.`;

async function main() {
	showHelp(argv, HELP_TEXT);

	// Validate parameters
	if (!argv.file) {
		throw new Error('--file parameter is required');
	}
	if (!argv.user && !argv.group) {
		throw new Error('Either --user or --group parameter is required');
	}
	if (argv.user && argv.group) {
		throw new Error('Cannot specify both --user and --group parameters');
	}

	const recipientType = argv.user ? 'user' : 'group';
	const recipientId = argv.user || argv.group;

	const validAccessLevels = ['CAN_VIEW', 'CAN_SHARE', 'CAN_EDIT', 'OWNER'];
	const accessLevel = (argv['access-level'] || 'CAN_VIEW').toUpperCase();
	if (!validAccessLevels.includes(accessLevel)) {
		throw new Error(
			`Invalid --access-level. Must be one of: ${validAccessLevels.join(', ')}`
		);
	}

	// Determine file type by extension
	const fileExtension = argv.file.toLowerCase().split('.').pop();
	let fileJson;

	if (fileExtension === 'csv') {
		// Handle CSV file using shared readCSV
		const records = readCSV(argv.file);
		const columns = Object.keys(records[0] || {});
		if (!columns.includes('Object ID') || !columns.includes('Object Type ID')) {
			throw new Error('CSV must have Object ID and Object Type ID columns');
		}
		fileJson = records.map((row) => {
			const rawType = row['Object Type ID'];
			let typeVal;
			if (rawType === 'CARD') {
				typeVal = 'badge';
			} else if (rawType === 'DATA_SOURCE' || rawType === 'DATASET') {
				typeVal = 'dataset';
			} else {
				typeVal = rawType.toLowerCase();
			}
			return {
				id: String(row['Object ID']),
				type: typeVal
			};
		});
	} else if (fileExtension === 'json') {
		const validContentTypes = [
			'card',
			'badge',
			'page',
			'dataApp',
			'alert',
			'dataset'
		];
		// Handle JSON file (array of integers + contentType parameter)
		if (!argv['content-type']) {
			throw new Error(
				`--content-type parameter is required for JSON files: ${validContentTypes.join(
					', '
				)}`
			);
		}

		let contentType = argv['content-type'].toLowerCase();

		// Convert card to badge for API
		if (contentType === 'card') {
			contentType = 'badge';
		}

		if (!validContentTypes.includes(contentType)) {
			throw new Error(
				`Invalid contentType. Must be one of: ${validContentTypes.join(
					', '
				)}, card`
			);
		}

		const data = fs.readFileSync(argv.file, 'utf8');
		const contentIds = JSON.parse(data);

		if (!Array.isArray(contentIds)) {
			throw new Error('JSON file must contain an array of integers');
		}

		// Validate that all elements are numbers
		const invalidIds = contentIds.filter((id) => !Number.isInteger(id));
		if (invalidIds.length > 0) {
			throw new Error(
				`Invalid content IDs found (must be integers): ${invalidIds
					.slice(0, 5)
					.join(', ')}${invalidIds.length > 5 ? '...' : ''}`
			);
		}

		// Convert array of integers to resources format
		fileJson = contentIds.map((id) => ({
			id: String(id),
			type: contentType
		}));

		console.log(
			`Loaded ${contentIds.length} ${argv['content-type']} IDs from ${argv.file}`
		);
	} else {
		throw new Error('File must have .csv or .json extension');
	}

	// Datasets use a separate per-item endpoint; split them out
	const datasetItems = fileJson.filter((item) => item.type === 'dataset');
	const contentItems = fileJson.filter((item) => item.type !== 'dataset');

	let successCount = 0;
	let errorCount = 0;

	// Process non-dataset items via the batched content-share endpoint
	if (contentItems.length > 0) {
		const batchSize = 50;
		const totalBatches = Math.ceil(contentItems.length / batchSize);

		console.log(
			`Processing ${contentItems.length} content items in batches of ${batchSize}...`
		);

		for (let start = 0; start < contentItems.length; start += batchSize) {
			const batch = contentItems.slice(start, start + batchSize);
			const batchNumber = Math.floor(start / batchSize) + 1;

			console.log(
				`Processing batch ${batchNumber}/${totalBatches} (${batch.length} items)...`
			);

			const body = {
				resources: batch,
				recipients: [
					{
						type: recipientType,
						id: recipientId
					}
				],
				message: 'Bulk sharing from script.'
			};

			try {
				const result = await api.post(
					'/content/v1/share?sendEmail=false',
					body
				);
				console.log(
					`Batch ${batchNumber} success:`,
					JSON.stringify(result, null, 2)
				);
				successCount++;
			} catch (error) {
				console.error(`Batch ${batchNumber} error:`, error.message);
				errorCount++;
			}

			if (start + batchSize < contentItems.length) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	}

	// Datasets use the bulk share endpoint: /data/v1/ui/bulk/share
	if (datasetItems.length > 0) {
		const batchSize = 50;
		const totalBatches = Math.ceil(datasetItems.length / batchSize);

		console.log(
			`\nProcessing ${datasetItems.length} dataset(s) with access level ${accessLevel} in batches of ${batchSize}...`
		);

		for (let start = 0; start < datasetItems.length; start += batchSize) {
			const batch = datasetItems.slice(start, start + batchSize);
			const batchNumber = Math.floor(start / batchSize) + 1;

			console.log(
				`Processing dataset batch ${batchNumber}/${totalBatches} (${batch.length} items)...`
			);

			const body = {
				bulkItems: {
					ids: batch.map((item) => String(item.id)),
					type: 'DATA_SOURCE'
				},
				dataSourceShareEntity: {
					permissions: [
						{
							accessLevel,
							id: String(recipientId),
							type: recipientType.toUpperCase()
						}
					],
					sendEmail: false,
					message: 'Bulk sharing from script.'
				}
			};

			try {
				const result = await api.post('/data/v1/ui/bulk/share', body);
				console.log(
					`Dataset batch ${batchNumber} success:`,
					JSON.stringify(result, null, 2)
				);
				successCount++;
			} catch (error) {
				console.error(`Dataset batch ${batchNumber} error:`, error.message);
				errorCount++;
			}

			if (start + batchSize < datasetItems.length) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	}

	// Summary
	console.log('\n=== Summary ===');
	console.log(`Total items processed: ${fileJson.length}`);
	console.log(`  Content items: ${contentItems.length}`);
	console.log(`  Datasets: ${datasetItems.length}`);
	console.log(`Successful operations: ${successCount}`);
	console.log(`Failed operations: ${errorCount}`);

	if (errorCount > 0) {
		console.error('\nSome operations failed. Check the error messages above.');
		process.exit(1);
	} else {
		console.log('\nAll operations completed successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
