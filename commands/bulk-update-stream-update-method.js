/**
 * Bulk update Domo streams to change update mode from Replace to Append
 *
 * Usage:
 *   node cli.js bulk-update-stream-update-method --file "stream-ids.csv"
 *   node cli.js bulk-update-stream-update-method --file "stream-ids.csv" --column "streamId"
 *   node cli.js bulk-update-stream-update-method --stream-id 12345
 *   node cli.js bulk-update-stream-update-method --stream-ids "123,456,789"
 *
 * Options:
 *   --file, -f        CSV file with stream IDs
 *   --stream-id       Single stream ID
 *   --stream-ids      Comma-separated stream IDs
 *   --column, -c      CSV column containing stream IDs (default: "streamId")
 *   --filter-column   CSV column to filter on (optional, requires --filter-value)
 *   --filter-value    Value the filter-column must equal to include the row
 */

const api = require('../lib/api');
const { resolveIds } = require('../lib/input');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-update-stream-update-method [options]

Bulk update Domo streams to change update mode from Replace to Append.

Options:
  --file, -f        CSV file with stream IDs
  --stream-id       Single stream ID
  --stream-ids      Comma-separated stream IDs
  --column, -c      CSV column containing stream IDs (default: "streamId")
  --filter-column   CSV column to filter on (optional, requires --filter-value)
  --filter-value    Value the filter-column must equal to include the row`;

function modifyUpdateMode(streamDefinition) {
	if (!streamDefinition.configuration || !Array.isArray(streamDefinition.configuration)) {
		console.warn('  No configuration array found');
		return { modified: false, definition: streamDefinition };
	}

	let modified = false;

	// Update the configuration array
	for (const config of streamDefinition.configuration) {
		if (config.name === 'updatemode.mode') {
			const oldValue = config.value;
			config.value = 'Append';
			modified = true;
			console.log(`  Changed updatemode.mode from ${oldValue} to Append`);
			break;
		}
	}

	if (!modified) {
		console.warn('  updatemode.mode configuration not found');
	}

	// Update the root-level updateMethod property
	if (streamDefinition.updateMethod) {
		const oldUpdateMethod = streamDefinition.updateMethod;
		streamDefinition.updateMethod = 'APPEND';
		console.log(`  Changed updateMethod from ${oldUpdateMethod} to APPEND`);
		modified = true;
	} else {
		// Set it if it doesn't exist
		streamDefinition.updateMethod = 'APPEND';
		console.log(`  Set updateMethod to APPEND`);
		modified = true;
	}

	return { modified, definition: streamDefinition };
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const { ids: streamIds } = resolveIds(argv, {
		name: 'stream',
		columnDefault: 'streamId'
	});

	console.log(`Processing ${streamIds.length} stream(s)...\n`);

	let successCount = 0;
	let skipCount = 0;
	let errorCount = 0;

	for (let i = 0; i < streamIds.length; i++) {
		const streamId = streamIds[i];
		console.log(`[${i + 1}/${streamIds.length}] Processing stream ${streamId}...`);

		try {
			// Get current stream definition
			console.log('  Fetching stream definition...');
			const streamDefinition = await api.get(`/data/v1/streams/${streamId}?fields=all`);

			// Modify the update mode
			const { modified, definition } = modifyUpdateMode(streamDefinition);

			if (modified) {
				// Update the stream
				console.log('  Updating stream...');
				await api.put(`/data/v1/streams/${streamId}`, definition);
				console.log('  ✓ Successfully updated\n');
				successCount++;
			} else {
				console.log('  ⊘ Skipped (no changes needed)\n');
				skipCount++;
			}
		} catch (error) {
			console.error(`  ✗ Error: ${error.message}\n`);
			errorCount++;
		}

		// Add a small delay between requests to avoid overwhelming the API
		if (i < streamIds.length - 1) {
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}

	// Summary
	console.log('=== Summary ===');
	console.log(`Total streams processed: ${streamIds.length}`);
	console.log(`Successfully updated: ${successCount}`);
	console.log(`Skipped (no changes): ${skipCount}`);
	console.log(`Errors: ${errorCount}`);

	if (errorCount > 0) {
		console.error('\nSome streams failed to update. Check the error messages above.');
		process.exit(1);
	} else {
		console.log('\nAll streams processed successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
