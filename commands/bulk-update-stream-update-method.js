/**
 * Bulk update Domo streams to change update mode from Replace to Append
 *
 * Usage:
 *   node cli.js bulk-update-stream-update-method --file "stream-ids.csv"
 *   node cli.js bulk-update-stream-update-method --file "stream-ids.csv" --column "streamId"
 *   node cli.js bulk-update-stream-update-method --id 12345
 *   node cli.js bulk-update-stream-update-method --ids "123,456,789"
 *   node cli.js bulk-update-stream-update-method --retry-errors
 *
 * Options:
 *   --file, -f        CSV file with stream IDs
 *   --id              Single stream ID
 *   --ids             Comma-separated stream IDs
 *   --column, -c      CSV column containing stream IDs (default: "streamId")
 *   --filter-column   CSV column to filter on (optional, requires --filter-value)
 *   --filter-value    Value the filter-column must equal to include the row
 *   --retry-errors [file]  Retry the failed and unreached streams of a run (default: latest run log)
 *   --max-age <hours>      Allow a source log older than 24 hours
 */

const { api, resolveIds, createLogger, loadSource, printSource, confirmSource, showHelp } = require('../lib');
const argv = require('minimist')(process.argv.slice(2));

const COMMAND = 'bulk-update-stream-update-method';
const SELECTION_FLAGS = ['file', 'f', 'id', 'ids', 'column', 'c', 'filter-column', 'filter-value'];

const HELP_TEXT = `Usage: node cli.js bulk-update-stream-update-method [options]

Bulk update Domo streams to change update mode from Replace to Append.

Options:
  --file, -f        CSV file with stream IDs
  --id              Single stream ID
  --ids             Comma-separated stream IDs
  --column, -c      CSV column containing stream IDs (default: "streamId")
  --filter-column   CSV column to filter on (optional, requires --filter-value)
  --filter-value    Value the filter-column must equal to include the row

Retrying an earlier run:
  --retry-errors [file]  Retry the failed and unreached items of a run (default: the latest run log)
  --max-age <hours>      Allow a source log older than 24 hours`;

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

	const source = loadSource(COMMAND, argv, {
		selectionFlags: SELECTION_FLAGS,
		modes: ['retry-errors'],
		toEntries: (row) => (row.streamId == null ? null : String(row.streamId))
	});

	let streamIds;
	let debugMode = false;
	if (source) {
		streamIds = source.entries;
	} else {
		({ ids: streamIds, debugMode } = resolveIds(argv, {
			idFlag: 'id',
			idsFlag: 'ids',
			columnDefault: 'streamId'
		}));
	}
	const entries = streamIds.map((streamId) => ({ streamId }));

	const logger = createLogger(COMMAND, {
		debugMode,
		source,
		runMeta: { updateMethod: 'APPEND' }
	});

	if (source) {
		printSource(source);
		if (streamIds.length === 0) {
			console.log('The source log has nothing left to retry.');
			process.exit(0);
		}
		if (!(await confirmSource(`Retry ${streamIds.length} stream(s)? (yes/no): `, argv))) {
			console.log('Cancelled.');
			process.exit(0);
		}
	}

	console.log(`Processing ${streamIds.length} stream(s)...\n`);
	logger.beginExecution(entries, (entry) => String(entry.streamId));

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
				logger.addResult({ streamId, status: 'updated' });
				if (debugMode) logger.writeDebugLog(streamId, { streamId, status: 'updated' });
				successCount++;
			} else {
				console.log('  ⊘ Skipped (no changes needed)\n');
				logger.addResult({ streamId, status: 'skipped' });
				if (debugMode) logger.writeDebugLog(streamId, { streamId, status: 'skipped' });
				skipCount++;
			}
		} catch (error) {
			console.error(`  ✗ Error: ${error.message}\n`);
			logger.addResult({ streamId, status: 'error', error: error.message });
			if (debugMode) logger.writeDebugLog(streamId, { streamId, status: 'error', error: error.message });
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

	logger.writeRunLog({ total: streamIds.length, updated: successCount, errors: errorCount });

	if (errorCount > 0) {
		console.error(`\nSome streams failed to update. Run "node cli.js ${COMMAND} --retry-errors" to retry them.`);
		process.exit(1);
	} else {
		console.log('\nAll streams processed successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
