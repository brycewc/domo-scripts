/**
 * Add a DATAFLOW_LAST_RUN trigger condition to all triggers on dataflows listed in a CSV file.
 *
 * Reads a CSV, extracts dataflow IDs from a configurable column (default "DataFlow ID"),
 * then for each dataflow: GETs the definition, adds the trigger condition to every trigger's
 * triggerConditions array (skipping if already present), and PUTs the full definition back.
 *
 * Usage:
 *   node cli.js bulk-add-dataflow-trigger-condition --file "dataflows.csv"
 *   node cli.js bulk-add-dataflow-trigger-condition --file "dataflows.csv" --column "id"
 *   node cli.js bulk-add-dataflow-trigger-condition --dataflow-id 123
 *   node cli.js bulk-add-dataflow-trigger-condition --dataflow-ids "123,456,789"
 *
 * Options:
 *   --file, -f       CSV file with dataflow IDs
 *   --column, -c     CSV column name containing dataflow IDs (default: "DataFlow ID")
 *   --dataflow-id    Single dataflow ID (enables debug logging)
 *   --dataflow-ids   Comma-separated dataflow IDs
 *   --filter-column  CSV column to filter on (optional, requires --filter-value)
 *   --filter-value   Value the filter-column must equal to include the row
 */

const api = require('../lib/api');
const { resolveIds } = require('../lib/input');
const { createLogger } = require('../lib/log');
const argv = require('minimist')(process.argv.slice(2));

const CONDITION_TO_ADD = {
	value: 1440,
	unit: 'MINUTE',
	negated: true,
	type: 'DATAFLOW_LAST_RUN'
};

function hasMatchingCondition(triggerConditions) {
	return triggerConditions.some(
		(c) =>
			c.type === CONDITION_TO_ADD.type &&
			c.value === CONDITION_TO_ADD.value &&
			c.unit === CONDITION_TO_ADD.unit &&
			c.negated === CONDITION_TO_ADD.negated
	);
}

function addTriggerConditions(definition) {
	const triggers = definition.triggerSettings?.triggers;
	if (!Array.isArray(triggers) || triggers.length === 0) {
		return { modified: false, triggersUpdated: 0 };
	}

	let triggersUpdated = 0;

	for (const trigger of triggers) {
		if (!Array.isArray(trigger.triggerConditions)) {
			trigger.triggerConditions = [];
		}

		if (hasMatchingCondition(trigger.triggerConditions)) {
			console.log(
				`    Trigger "${trigger.title || trigger.triggerId}" already has condition, skipping`
			);
			continue;
		}

		trigger.triggerConditions.push({ ...CONDITION_TO_ADD });
		triggersUpdated++;
		console.log(
			`    Added condition to trigger "${trigger.title || trigger.triggerId}"`
		);
	}

	if (triggersUpdated > 0) {
		// Migrate from legacy executeFlowWhenUpdated to triggerSettings system.
		// triggerSettings.triggerEvents already reference the same datasets,
		// so disable the old mechanism so the API processes triggerSettings.
		definition.triggeredByInput = false;
		if (Array.isArray(definition.inputs)) {
			for (const input of definition.inputs) {
				input.executeFlowWhenUpdated = false;
			}
		}
		if (Array.isArray(definition.actions)) {
			for (const action of definition.actions) {
				if (action.type === 'LoadFromVault') {
					action.executeFlowWhenUpdated = false;
				}
			}
		}
		definition.onboardFlowVersion = {
			description: 'Updated the scheduled settings.',
			onboardFlowId: definition.id
		};
	}

	return { modified: triggersUpdated > 0, triggersUpdated };
}

function printUsage() {
	console.log('Usage:');
	console.log(
		'  node cli.js bulk-add-dataflow-trigger-condition --file "dataflows.csv"'
	);
	console.log(
		'  node cli.js bulk-add-dataflow-trigger-condition --file "dataflows.csv" --column "id"'
	);
	console.log(
		'  node cli.js bulk-add-dataflow-trigger-condition --dataflow-id 123'
	);
	console.log(
		'  node cli.js bulk-add-dataflow-trigger-condition --dataflow-ids "123,456,789"'
	);
	console.log('\nOptions:');
	console.log('  --file, -f       CSV file with dataflow IDs');
	console.log(
		'  --column, -c     CSV column name containing dataflow IDs (default: "DataFlow ID")'
	);
	console.log('  --dataflow-id    Single dataflow ID (enables debug logging)');
	console.log('  --dataflow-ids   Comma-separated dataflow IDs');
	console.log('  --filter-column  CSV column to filter on');
	console.log('  --filter-value   Value the filter-column must equal');
}

async function main() {
	if (argv.help || argv.h) {
		printUsage();
		process.exit(0);
	}

	if (!argv.file && !argv.f && !argv['dataflow-id'] && !argv['dataflow-ids']) {
		console.error('Error: --file, --dataflow-id, or --dataflow-ids is required\n');
		printUsage();
		process.exit(1);
	}

	const { ids: dataflowIds, debugMode } = resolveIds(argv, {
		name: 'dataflow',
		columnDefault: 'DataFlow ID'
	});

	const logger = createLogger('bulkAddDataflowTriggerConditions', {
		debugMode,
		runMeta: {
			file: argv.file || argv.f || null,
			column: argv.column || argv.c || 'DataFlow ID',
			totalDataflows: dataflowIds.length
		}
	});

	if (debugMode) {
		console.log(
			`Processing single dataflow ${dataflowIds[0]} (debug log enabled)\n`
		);
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

		const debugLog = debugMode
			? { dataflowId, timestamp: new Date().toISOString() }
			: null;

		const entry = { dataflowId, status: null, name: null, error: null };

		try {
			console.log('  Fetching dataflow definition...');
			const definition = await api.get(
				`/dataprocessing/v2/dataflows/${dataflowId}`
			);
			entry.name = definition.name;
			console.log(`  Name: "${definition.name}"`);

			if (debugLog) {
				debugLog.originalDefinition = JSON.parse(JSON.stringify(definition));
				debugLog.originalTriggerSettings = JSON.parse(
					JSON.stringify(definition.triggerSettings || null)
				);
			}

			const { modified, triggersUpdated } = addTriggerConditions(definition);

			if (debugLog) {
				debugLog.modified = modified;
				debugLog.triggersUpdated = triggersUpdated;
				debugLog.modifiedTriggerSettings = JSON.parse(
					JSON.stringify(definition.triggerSettings || null)
				);
			}

			if (modified) {
				console.log('  Updating dataflow...');
				const putResult = await api.put(
					`/dataprocessing/v1/dataflows/${dataflowId}`,
					definition
				);
				console.log('  Successfully updated\n');
				entry.status = 'updated';
				entry.triggersUpdated = triggersUpdated;
				if (debugLog) {
					debugLog.putRequestBody = definition;
					debugLog.putResponse = putResult;
				}
				successCount++;
			} else {
				console.log('  Skipped (no changes needed)\n');
				entry.status = 'skipped';
				skipCount++;
			}
		} catch (error) {
			console.error(`  Error: ${error.message}\n`);
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
	console.log(`Successfully updated: ${successCount}`);
	console.log(`Skipped (no changes): ${skipCount}`);
	console.log(`Errors: ${errorCount}`);

	logger.writeRunLog({ successCount, skipCount, errorCount });

	if (errorCount > 0) {
		console.error(
			'\nSome dataflows failed to update. Check the error messages above.'
		);
		process.exit(1);
	} else {
		console.log('\nAll dataflows processed successfully!');
	}
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});
