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
 *   node cli.js bulk-add-dataflow-trigger-condition --id 123
 *   node cli.js bulk-add-dataflow-trigger-condition --ids "123,456,789"
 *   node cli.js bulk-add-dataflow-trigger-condition --retry-errors
 *
 * Options:
 *   --file, -f       CSV file with dataflow IDs
 *   --column, -c     CSV column name containing dataflow IDs (default: "DataFlow ID")
 *   --id             Single dataflow ID (enables debug logging)
 *   --ids            Comma-separated dataflow IDs
 *   --filter-column  CSV column to filter on (optional, requires --filter-value)
 *   --filter-value   Value the filter-column must equal to include the row
 *   --value          Condition value (default: 1440)
 *   --unit           Condition unit (default: "MINUTE")
 *   --no-negated     Set negated to false (default: negated is true)
 *   --type           Condition type (default: "DATAFLOW_LAST_RUN")
 *   --description    Version description recorded on the dataflow. {value} and {unit}
 *                    are replaced with the condition value/unit
 *                    (default: "Updated the schedule settings to limit triggers to {value}")
 *   --retry-errors [file]  Retry the failed and unreached dataflows of a run (default: latest run log)
 *   --max-age <hours>      Allow a source log older than 24 hours
 */

const api = require('../lib/api');
const { resolveIds } = require('../lib/input');
const { createLogger } = require('../lib/log');
const { loadSource, printSource, confirmSource } = require('../lib/plan');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const COMMAND = 'bulk-add-dataflow-trigger-condition';
const SELECTION_FLAGS = [
	'file',
	'f',
	'column',
	'c',
	'id',
	'ids',
	'filter-column',
	'filter-value',
	'value',
	'unit',
	'negated',
	'type',
	'description'
];

const HELP_TEXT = `Usage:
  node cli.js bulk-add-dataflow-trigger-condition --file "dataflows.csv"
  node cli.js bulk-add-dataflow-trigger-condition --file "dataflows.csv" --column "id"
  node cli.js bulk-add-dataflow-trigger-condition --id 123
  node cli.js bulk-add-dataflow-trigger-condition --ids "123,456,789"

Options:
  --file, -f       CSV file with dataflow IDs
  --column, -c     CSV column name containing dataflow IDs (default: "DataFlow ID")
  --id             Single dataflow ID (enables debug logging)
  --ids            Comma-separated dataflow IDs
  --filter-column  CSV column to filter on
  --filter-value   Value the filter-column must equal
  --value          Condition value (default: 1440)
  --unit           Condition unit (default: "MINUTE")
  --no-negated     Set negated to false (default: negated is true)
  --type           Condition type (default: "DATAFLOW_LAST_RUN")
  --description    Version description recorded on the dataflow. {value} and {unit}
                   are replaced with the condition value/unit
                   (default: "Updated the schedule settings to limit triggers to {value}")

Retrying an earlier run (reuses the log's condition and description):
  --retry-errors [file]  Retry the failed and unreached items of a run (default: the latest run log)
  --max-age <hours>      Allow a source log older than 24 hours`;

function conditionFromArgs() {
	return {
		value: argv.value !== undefined ? argv.value : 1440,
		unit: argv.unit || 'MINUTE',
		negated: argv.negated !== undefined ? argv.negated : true,
		type: argv.type || 'DATAFLOW_LAST_RUN'
	};
}

function hasMatchingCondition(triggerConditions, condition) {
	return triggerConditions.some(
		(c) =>
			c.type === condition.type &&
			c.value === condition.value &&
			c.unit === condition.unit &&
			c.negated === condition.negated
	);
}

function addTriggerConditions(definition, condition, description) {
	const triggers = definition.triggerSettings?.triggers;
	if (!Array.isArray(triggers) || triggers.length === 0) {
		return { modified: false, triggersUpdated: 0 };
	}

	let triggersUpdated = 0;

	for (const trigger of triggers) {
		if (!Array.isArray(trigger.triggerConditions)) {
			trigger.triggerConditions = [];
		}

		if (hasMatchingCondition(trigger.triggerConditions, condition)) {
			console.log(`    Trigger "${trigger.title || trigger.triggerId}" already has condition, skipping`);
			continue;
		}

		trigger.triggerConditions.push({ ...condition });
		triggersUpdated++;
		console.log(`    Added condition to trigger "${trigger.title || trigger.triggerId}"`);
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
			description,
			onboardFlowId: definition.id
		};
	}

	return { modified: triggersUpdated > 0, triggersUpdated };
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const source = loadSource(COMMAND, argv, {
		selectionFlags: SELECTION_FLAGS,
		modes: ['retry-errors'],
		toEntries: (row) => (row.dataflowId == null ? null : String(row.dataflowId))
	});

	if (!source && !argv.file && !argv.f && !argv.id && !argv.ids) {
		console.error('Error: --file, --id, or --ids is required\n');
		console.error(HELP_TEXT);
		process.exit(1);
	}

	let condition;
	let description;
	if (source) {
		({ condition, description } = source.meta);
		if (!condition) {
			console.error(`Error: ${source.relPath} does not record the trigger condition, so it cannot be retried.`);
			process.exit(1);
		}
	} else {
		condition = conditionFromArgs();
		const descriptionTemplate =
			typeof argv.description === 'string' && argv.description
				? argv.description
				: 'Updated the schedule settings to limit trigger';
		description = descriptionTemplate
			.replaceAll('{value}', condition.value)
			.replaceAll('{unit}', condition.unit);
	}

	let dataflowIds;
	let debugMode = false;
	if (source) {
		dataflowIds = source.entries;
	} else {
		({ ids: dataflowIds, debugMode } = resolveIds(argv, {
			idFlag: 'id',
			idsFlag: 'ids',
			columnDefault: 'DataFlow ID'
		}));
	}

	const logger = createLogger(COMMAND, {
		debugMode,
		source,
		runMeta: {
			file: source ? source.meta.file : argv.file || argv.f || null,
			column: source ? source.meta.column : argv.column || argv.c || 'DataFlow ID',
			condition,
			description,
			totalDataflows: dataflowIds.length
		}
	});

	if (source) {
		printSource(source);
		if (dataflowIds.length === 0) {
			console.log('The source log has nothing left to retry.');
			process.exit(0);
		}
		if (!(await confirmSource(`Retry ${dataflowIds.length} dataflow(s)? (yes/no): `, argv))) {
			console.log('Cancelled.');
			process.exit(0);
		}
	}
	logger.beginExecution(
		dataflowIds.map((dataflowId) => ({ dataflowId })),
		(entry) => String(entry.dataflowId)
	);

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

		const entry = { dataflowId, status: null, name: null, error: null };

		try {
			console.log('  Fetching dataflow definition...');
			const definition = await api.get(`/dataprocessing/v2/dataflows/${dataflowId}`);
			entry.name = definition.name;
			console.log(`  Name: "${definition.name}"`);

			if (debugLog) {
				debugLog.originalDefinition = JSON.parse(JSON.stringify(definition));
				debugLog.originalTriggerSettings = JSON.parse(JSON.stringify(definition.triggerSettings || null));
			}

			const { modified, triggersUpdated } = addTriggerConditions(definition, condition, description);

			if (debugLog) {
				debugLog.modified = modified;
				debugLog.triggersUpdated = triggersUpdated;
				debugLog.modifiedTriggerSettings = JSON.parse(JSON.stringify(definition.triggerSettings || null));
			}

			if (modified) {
				console.log('  Updating dataflow...');
				const putResult = await api.put(`/dataprocessing/v1/dataflows/${dataflowId}`, definition);
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
		console.error(`\nSome dataflows failed to update. Run "node cli.js ${COMMAND} --retry-errors" to retry them.`);
		process.exit(1);
	} else {
		console.log('\nAll dataflows processed successfully!');
	}
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});
