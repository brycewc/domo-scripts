/**
 * Delete all triggers from dataflows listed in a CSV file (or by ID).
 *
 * Reads a CSV, extracts dataflow IDs from a configurable column (default "DataFlow ID"),
 * then for each dataflow: GETs the definition, nulls triggerSettings and scheduleInfo,
 * flips every inputs[].executeFlowWhenUpdated and actions[].executeFlowWhenUpdated flag
 * to false, and PUTs the full definition back. Skips dataflows that have no triggers to begin
 * with.
 *
 * Some dataflow types (e.g. MySQL) represent dataset-update triggers in two places:
 * the triggerSettings object AND a per-input executeFlowWhenUpdated flag on both
 * `inputs[]` and the matching LoadFromVault entry in `actions[]`. Clearing only
 * triggerSettings leaves the input-level flag set, and Domo keeps firing the
 * dataflow on dataset updates — so we must clear both.
 *
 * Time-based (SCHEDULE) triggers are mirrored the same way: the schedule lives in
 * triggerSettings AND in a top-level scheduleInfo cron object, so we null both.
 *
 * Usage:
 *   node cli.js bulk-delete-dataflow-triggers --file "dataflows.csv"
 *   node cli.js bulk-delete-dataflow-triggers --file "dataflows.csv" --column "id"
 *   node cli.js bulk-delete-dataflow-triggers --id 123
 *   node cli.js bulk-delete-dataflow-triggers --ids "123,456,789"
 *   node cli.js bulk-delete-dataflow-triggers --file "dataflows.csv" --dry-run
 *
 * Options:
 *   --file, -f       CSV file with dataflow IDs
 *   --column, -c     CSV column name containing dataflow IDs (default: "DataFlow ID")
 *   --id             Single dataflow ID (enables debug logging)
 *   --ids            Comma-separated dataflow IDs
 *   --filter-column  CSV column to filter on (optional, requires --filter-value)
 *   --filter-value   Value the filter-column must equal to include the row
 *   --description    Version description recorded on the dataflow (default: "Removed all triggers via script")
 *   --dry-run        Preview which dataflows would be modified without applying
 */

const api = require('../lib/api');
const { resolveIds } = require('../lib/input');
const { createLogger } = require('../lib/log');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage:
  node cli.js bulk-delete-dataflow-triggers --file "dataflows.csv"
  node cli.js bulk-delete-dataflow-triggers --file "dataflows.csv" --column "id"
  node cli.js bulk-delete-dataflow-triggers --id 123
  node cli.js bulk-delete-dataflow-triggers --ids "123,456,789"
  node cli.js bulk-delete-dataflow-triggers --file "dataflows.csv" --dry-run

WARNING: This removes all triggers from each dataflow. They will no longer
run automatically on any schedule or input update.

Options:
  --file, -f       CSV file with dataflow IDs
  --column, -c     CSV column name containing dataflow IDs (default: "DataFlow ID")
  --id             Single dataflow ID (enables debug logging)
  --ids            Comma-separated dataflow IDs
  --filter-column  CSV column to filter on
  --filter-value   Value the filter-column must equal
  --description    Version description recorded on the dataflow (default: "Removed all triggers via script")
  --dry-run        Preview without applying changes`;

function clearTriggers(definition, description) {
	const triggers = definition.triggerSettings?.triggers;
	const triggersRemoved = Array.isArray(triggers) ? triggers.length : 0;
	const eventsRemoved = Array.isArray(triggers)
		? triggers.reduce((sum, t) => sum + (Array.isArray(t?.triggerEvents) ? t.triggerEvents.length : 0), 0)
		: 0;

	const scheduleRemoved = definition.scheduleInfo != null;

	let inputTriggersRemoved = 0;
	if (Array.isArray(definition.inputs)) {
		for (const input of definition.inputs) {
			if (input && input.executeFlowWhenUpdated === true) {
				input.executeFlowWhenUpdated = false;
				inputTriggersRemoved++;
			}
		}
	}

	let actionTriggersRemoved = 0;
	if (Array.isArray(definition.actions)) {
		for (const action of definition.actions) {
			if (action && action.executeFlowWhenUpdated === true) {
				action.executeFlowWhenUpdated = false;
				actionTriggersRemoved++;
			}
		}
	}

	const modified =
		triggersRemoved > 0 ||
		eventsRemoved > 0 ||
		scheduleRemoved ||
		inputTriggersRemoved > 0 ||
		actionTriggersRemoved > 0;

	if (!modified) {
		return {
			modified: false,
			triggersRemoved: 0,
			eventsRemoved: 0,
			scheduleRemoved: false,
			inputTriggersRemoved: 0,
			actionTriggersRemoved: 0
		};
	}

	definition.triggerSettings = null;
	definition.scheduleInfo = null;

	definition.onboardFlowVersion = {
		description,
		onboardFlowId: definition.id
	};

	return {
		modified: true,
		triggersRemoved,
		eventsRemoved,
		scheduleRemoved,
		inputTriggersRemoved,
		actionTriggersRemoved
	};
}

async function main() {
	showHelp(argv, HELP_TEXT);

	if (!argv.file && !argv.f && !argv.id && !argv.ids) {
		console.error('Error: --file, --id, or --ids is required\n');
		console.error(HELP_TEXT);
		process.exit(1);
	}

	const dryRun = argv['dry-run'] || argv.dry || false;
	const description = argv.description || 'Removed all triggers via script';

	const { ids: dataflowIds, debugMode } = resolveIds(argv, {
		idFlag: 'id',
		idsFlag: 'ids',
		columnDefault: 'DataFlow ID'
	});

	const logger = createLogger('bulk-delete-dataflow-triggers', {
		debugMode,
		dryRun,
		runMeta: {
			file: argv.file || argv.f || null,
			column: argv.column || argv.c || 'DataFlow ID',
			description,
			totalDataflows: dataflowIds.length
		}
	});

	console.log('Bulk Delete Dataflow Triggers');
	console.log('=============================\n');
	if (dryRun) {
		console.log('*** DRY RUN — no dataflows will be modified ***\n');
	}
	if (debugMode) {
		console.log(`Processing single dataflow ${dataflowIds[0]} (debug log enabled)\n`);
	} else {
		console.log(`Found ${dataflowIds.length} dataflow(s) to process\n`);
	}

	let successCount = 0;
	let skipCount = 0;
	let errorCount = 0;

	for (let i = 0; i < dataflowIds.length; i++) {
		const dataflowId = dataflowIds[i];
		const progress = `[${i + 1}/${dataflowIds.length}]`;
		console.log(`${progress} Processing dataflow ${dataflowId}...`);

		const debugLog = debugMode ? { dataflowId, timestamp: new Date().toISOString() } : null;

		const entry = {
			dataflowId,
			status: null,
			name: null,
			triggersRemoved: 0,
			eventsRemoved: 0,
			scheduleRemoved: false,
			inputTriggersRemoved: 0,
			actionTriggersRemoved: 0,
			error: null
		};

		try {
			console.log('  Fetching dataflow definition...');
			const definition = await api.get(`/dataprocessing/v2/dataflows/${dataflowId}`);
			entry.name = definition.name;
			console.log(`  Name: "${definition.name}"`);

			if (debugLog) {
				debugLog.originalDefinition = JSON.parse(JSON.stringify(definition));
				debugLog.originalTriggerSettings = JSON.parse(JSON.stringify(definition.triggerSettings || null));
				debugLog.originalScheduleInfo = JSON.parse(JSON.stringify(definition.scheduleInfo || null));
			}

			const { modified, triggersRemoved, eventsRemoved, scheduleRemoved, inputTriggersRemoved, actionTriggersRemoved } =
				clearTriggers(definition, description);

			entry.triggersRemoved = triggersRemoved;
			entry.eventsRemoved = eventsRemoved;
			entry.scheduleRemoved = scheduleRemoved;
			entry.inputTriggersRemoved = inputTriggersRemoved;
			entry.actionTriggersRemoved = actionTriggersRemoved;

			if (debugLog) {
				debugLog.modified = modified;
				debugLog.triggersRemoved = triggersRemoved;
				debugLog.eventsRemoved = eventsRemoved;
				debugLog.scheduleRemoved = scheduleRemoved;
				debugLog.inputTriggersRemoved = inputTriggersRemoved;
				debugLog.actionTriggersRemoved = actionTriggersRemoved;
				debugLog.modifiedTriggerSettings = JSON.parse(JSON.stringify(definition.triggerSettings || null));
				debugLog.modifiedScheduleInfo = JSON.parse(JSON.stringify(definition.scheduleInfo || null));
				debugLog.modifiedInputs = JSON.parse(JSON.stringify(definition.inputs || null));
				debugLog.modifiedActions = JSON.parse(JSON.stringify(definition.actions || null));
			}

			const summary = `${triggersRemoved} trigger(s), ${eventsRemoved} trigger event(s), ${scheduleRemoved ? 1 : 0} schedule(s), ${inputTriggersRemoved} input flag(s), ${actionTriggersRemoved} action flag(s)`;

			if (!modified) {
				console.log('  Skipped (no triggers to delete)\n');
				entry.status = 'skipped';
				skipCount++;
			} else if (dryRun) {
				console.log(`  [DRY RUN] Would remove ${summary}\n`);
				entry.status = 'dry-run';
				successCount++;
			} else {
				console.log(`  Removing ${summary}...`);
				const putResult = await api.put(`/dataprocessing/v1/dataflows/${dataflowId}`, definition);
				console.log('  ✓ Successfully updated\n');
				entry.status = 'updated';
				if (debugLog) {
					debugLog.putRequestBody = definition;
					debugLog.putResponse = putResult;
				}
				successCount++;
			}
		} catch (error) {
			console.error(`  ✗ Error: ${error.message}\n`);
			entry.status = 'error';
			entry.error = error.message;
			if (debugLog) debugLog.error = error.message;
			errorCount++;
		}

		if (debugLog) {
			logger.writeDebugLog(`dataflow_${dataflowId}`, debugLog);
		}

		logger.addResult(entry);

		if (i < dataflowIds.length - 1) {
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}

	console.log('=== Summary ===');
	console.log(`Total dataflows processed: ${dataflowIds.length}`);
	console.log(`${dryRun ? 'Would be updated' : 'Successfully updated'}: ${successCount}`);
	console.log(`Skipped (no triggers): ${skipCount}`);
	console.log(`Errors: ${errorCount}`);

	logger.writeRunLog({ successCount, skipCount, errorCount });

	if (errorCount > 0) {
		console.error('\nSome dataflows failed to update. Check the error messages above.');
		process.exit(1);
	} else if (dryRun) {
		console.log('\nRe-run without --dry-run to apply the changes.');
	} else {
		console.log('\nAll dataflows processed successfully!');
	}
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});
