/**
 * Share content in bulk using a CSV or JSON file of content IDs
 *
 * Usage:
 *   node cli.js bulk-share-content --file "content.csv" --user "1250228141"
 *   node cli.js bulk-share-content --file "content.csv" --group "12345"
 *   node cli.js bulk-share-content --file "card-ids.json" --user "1250228141" --content-type "card"
 *   node cli.js bulk-share-content --file "badge-ids.json" --group "12345" --content-type "badge"
 *
 * Options:
 *   --file             CSV or JSON file with content IDs (required)
 *   --user             User ID to share with (required if --group not set)
 *   --group            Group ID to share with (required if --user not set)
 *   --content-type     Content type for JSON files: card, badge, page, dataApp, alert (required for JSON)
 *
 * CSV format: Must have "Object ID" and "Object Type ID" columns.
 * JSON format: Must be an array of integers. Requires --content-type.
 */

const api = require('../lib/api');
const { readCSV } = require('../lib/csv');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));

async function main() {
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
			let typeVal = row['Object Type ID'];
			typeVal = typeVal === 'CARD' ? 'badge' : typeVal.toLowerCase();
			return {
				id: String(row['Object ID']),
				type: typeVal
			};
		});
	} else if (fileExtension === 'json') {
		const validContentTypes = ['card', 'badge', 'page', 'dataApp', 'alert'];
		// Handle JSON file (array of integers + contentType parameter)
		if (!argv['content-type']) {
			throw new Error(
				`--content-type parameter is required for JSON files ${validContentTypes.join(
					', '
				)}`
			);
		}

		let contentType = argv['content-type'].toLowerCase();

		// Convert card to badge for API
		if (contentType === 'card') {
			contentType = 'badge';
		}

		if (
			!validContentTypes.includes(contentType) &&
			argv['content-type'].toLowerCase() !== 'card'
		) {
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

	const batchSize = 50;
	let successCount = 0;
	let errorCount = 0;
	const totalBatches = Math.ceil(fileJson.length / batchSize);

	console.log(
		`Processing ${fileJson.length} items in batches of ${batchSize}...`
	);

	for (let start = 0; start < fileJson.length; start += batchSize) {
		const batch = fileJson.slice(start, start + batchSize);
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

		// Add a small delay between batches to avoid overwhelming the API
		if (start + batchSize < fileJson.length) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	// Summary
	console.log('\n=== Summary ===');
	console.log(`Total items processed: ${fileJson.length}`);
	console.log(`Successful batches: ${successCount}`);
	console.log(`Failed batches: ${errorCount}`);

	if (errorCount > 0) {
		console.error('\nSome batches failed. Check the error messages above.');
		process.exit(1);
	} else {
		console.log('\nAll batches completed successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
