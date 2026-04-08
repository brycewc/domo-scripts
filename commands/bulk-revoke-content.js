/**
 * Revoke access to content in bulk using an array of content IDs from a JSON or CSV file
 *
 * Usage:
 *   node cli.js bulk-revoke-content --file "cards-diff.json" --user "1250228141" --content-type "card"
 *   node cli.js bulk-revoke-content --file "cards-diff.json" --group "12345" --content-type "badge"
 *   node cli.js bulk-revoke-content --file "file.csv" --user "142591333" --content-type "card"
 *   node cli.js bulk-revoke-content --file "file.csv" --user "142591333" --content-type "page"
 *   node cli.js bulk-revoke-content --file "page-ids.json" --user "1250228141" --content-type "page"
 *   node cli.js bulk-revoke-content --file "app-ids.json" --group "12345" --content-type "dataApp"
 *   node cli.js bulk-revoke-content --file "alert-ids.json" --user "1250228141" --content-type "alert"
 *
 * Options:
 *   --file             CSV or JSON file with content IDs (required)
 *   --user             User ID to revoke from (required if --group not set)
 *   --group            Group ID to revoke from (required if --user not set)
 *   --content-type     Content type: card, badge, page, dataApp, alert (required)
 *
 * CSV format: Must have one of these columns: "Object ID", "Entity ID", or "id".
 * JSON format: Must be an array of integers.
 */

const api = require('../lib/api');
const { readCSV } = require('../lib/csv');
const { baseUrl } = require('../lib/config');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));

async function main() {
	const validContentTypes = ['card', 'badge', 'page', 'dataapp', 'alert'];

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
	if (!argv['content-type']) {
		throw new Error(
			`--content-type parameter is required (${validContentTypes.join(', ')})`
		);
	}

	const recipientType = argv.user ? 'user' : 'group';
	const recipientId = argv.user || argv.group;

	// Validate and normalize content type
	let contentType = argv['content-type'].toLowerCase();

	// Convert card to badge for API endpoint
	if (contentType === 'card') {
		contentType = 'badge';
	}

	if (!validContentTypes.includes(contentType)) {
		throw new Error(
			`Invalid contentType. Must be one of: ${validContentTypes.join(', ')}`
		);
	}

	const displayType = argv['content-type']; // Keep original for display purposes

	// Determine file type by extension
	const fileExtension = argv.file.toLowerCase().split('.').pop();
	let contentIds;

	if (fileExtension === 'json') {
		// Handle JSON file (array of integers)
		const data = fs.readFileSync(argv.file, 'utf8');
		contentIds = JSON.parse(data);

		if (!Array.isArray(contentIds)) {
			throw new Error('JSON file must contain an array of integers');
		}

		// Validate that all elements are numbers
		const invalidIds = contentIds.filter((id) => !Number.isInteger(id));
		if (invalidIds.length > 0) {
			throw new Error(
				`Invalid ${displayType} IDs found (must be integers): ${invalidIds
					.slice(0, 5)
					.join(', ')}${invalidIds.length > 5 ? '...' : ''}`
			);
		}

		console.log(
			`Loaded ${contentIds.length} ${displayType} IDs from ${argv.file}`
		);
	} else if (fileExtension === 'csv') {
		// Handle CSV file using shared readCSV
		const records = readCSV(argv.file);

		// Try to find the ID column with multiple possible names
		const columns = Object.keys(records[0] || {});
		const idColumn = ['Object ID', 'Entity ID', 'id'].find((c) =>
			columns.includes(c)
		);

		if (!idColumn) {
			throw new Error(
				'CSV must have one of these columns: Object ID, Entity ID, or id'
			);
		}

		contentIds = records
			.map((r) => parseInt(r[idColumn], 10))
			.filter((id) => !isNaN(id));

		console.log(
			`Loaded ${contentIds.length} ${displayType} IDs from ${argv.file} (using column: ${idColumn})`
		);
	} else {
		throw new Error('File must have .csv or .json extension');
	}

	const endpoint = `/content/v1/share/bulk/${contentType}/${recipientType}/${recipientId}`;

	console.log(
		`Revoking access to ${contentIds.length} ${displayType}s for ${recipientType} ${recipientId}...`
	);
	console.log(`Endpoint: ${baseUrl}${endpoint}`);
	console.log('Processing in batches of 50...');

	const batchSize = 50;
	let successCount = 0;
	let errorCount = 0;
	const ownerBody = {
		note: '',
		entityIds: contentIds.map(String),
		owners: [
			{
				type: 'GROUP',
				id: 144874194
			}
		],
		sendEmail: false
	};

	// Special handling for dataapps: add group 144874194 as owner first
	if (contentType === 'dataapp') {
		console.log('\n=== Adding group 144874194 as owner to all dataapps ===');
		try {
			await api.put('/content/v1/dataapps/bulk/owners', ownerBody);
			console.log(
				'Successfully added group 144874194 as owner to all dataapps'
			);
		} catch (error) {
			console.error(`Failed to add owner: ${error.message}`);
		}
		console.log('');
	}

	// Process in batches of 50
	for (let start = 0; start < contentIds.length; start += batchSize) {
		const batch = contentIds.slice(start, start + batchSize);
		const batchNumber = Math.floor(start / batchSize) + 1;
		const totalBatches = Math.ceil(contentIds.length / batchSize);

		console.log(
			`Processing batch ${batchNumber}/${totalBatches} (${batch.length} ${displayType}s)... ${JSON.stringify(batch)}`
		);

		try {
			let result;

			if (contentType === 'dataapp') {
				// Use special endpoint for dataapps
				result = await api.post('/content/v1/dataapps/share/remove', {
					dataAppIds: batch.map(String),
					recipients: [
						{
							id: parseInt(recipientId),
							type: recipientType
						}
					]
				});
			} else {
				// Use original endpoint for other content types
				result = await api.post(endpoint, batch);
			}

			console.log(
				`Batch ${batchNumber} success:`,
				result ? JSON.stringify(result, null, 2) : `No response body`
			);
			successCount++;
		} catch (error) {
			console.error(`Batch ${batchNumber} error:`, error.message);
			errorCount++;
		}

		// Add a small delay between batches to avoid overwhelming the API
		if (start + batchSize < contentIds.length) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	// Special handling for dataapps: remove group 144874194 as owner after revoking
	if (contentType === 'dataapp') {
		console.log(
			'\n=== Removing group 144874194 as owner from all dataapps ==='
		);
		const removeBody = {
			entityIds: ownerBody.entityIds,
			owners: ownerBody.owners
		};
		try {
			await api.post('/content/v1/dataapps/bulk/owners/remove', removeBody);
			console.log(
				'Successfully removed group 144874194 as owner from all dataapps'
			);
		} catch (error) {
			console.error(`Failed to remove owner: ${error.message}`);
		}
		console.log('');
	}

	// Summary
	console.log('\n=== Summary ===');
	console.log(`Total ${displayType}s processed: ${contentIds.length}`);
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
