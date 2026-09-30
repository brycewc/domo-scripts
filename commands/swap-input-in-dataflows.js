/**
 * Replace a dataset in all dataflows that use it
 *
 * Finds every dataflow that uses the old dataset as an input, validates schema
 * compatibility between old and new datasets, then updates each dataflow to
 * reference the new dataset instead.
 *
 * --from-dry-run and --retry-errors skip the lineage, name and schema lookups,
 * then re-fetch each dataflow and skip it as drifted if its version or its
 * reference count changed since the log was written.
 *
 * Usage:
 *   node cli.js swap-input-in-dataflows --old-dataset-id "<uuid>" --new-dataset-id "<uuid>"
 *   node cli.js swap-input-in-dataflows --old-dataset-id "<uuid>" --new-dataset-id "<uuid>" --dry-run
 *   node cli.js swap-input-in-dataflows --old-dataset-id "<uuid>" --new-dataset-id "<uuid>" --skip-schema-check
 *   node cli.js swap-input-in-dataflows --from-dry-run
 *   node cli.js swap-input-in-dataflows --retry-errors
 *
 * Options:
 *   --old-dataset-id       The dataset ID to find and replace (required)
 *   --new-dataset-id       The dataset ID to replace it with (required)
 *   --dry-run              Show what would change without making updates
 *   --skip-schema-check    Skip the schema comparison step
 *   --from-dry-run [file]  Run exactly what a dry run planned (default: the latest dry run log)
 *   --retry-errors [file]  Retry the failed and unreached items of a run (default: the latest run log)
 *   --max-age <hours>      Allow a source log older than 24 hours
 */

const { api, confirmSource, createLogger, loadSource, printSource, showHelp } = require('../lib');
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

const COMMAND = 'swap-input-in-dataflows';
const SELECTION_FLAGS = ['old-dataset-id', 'new-dataset-id', 'skip-schema-check', 'dry-run'];

const HELP_TEXT = `Usage: node cli.js swap-input-in-dataflows [options]

Options:
  --old-dataset-id       The dataset ID to find and replace (required)
  --new-dataset-id       The dataset ID to replace it with (required)
  --dry-run              Show what would change without making updates
  --skip-schema-check    Skip the schema comparison step

Reusing an earlier run (skips discovery; the log's dataset IDs are reused):
  --from-dry-run [file]  Run exactly what a dry run planned (default: the latest dry run log)
  --retry-errors [file]  Retry the failed and unreached items of a run (default: the latest run log)
  --max-age <hours>      Allow a source log older than 24 hours`;

const DELAY_MS = 500;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function prompt(question) {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase());
		});
	});
}

async function getDatasetSchema(datasetId) {
	return api.get(
		`/query/v1/datasources/${encodeURIComponent(datasetId)}/schema/indexed?includeHidden=true`
	);
}

async function getLineage(datasetId) {
	return api.get(
		`/data/v1/lineage/DATA_SOURCE/${encodeURIComponent(datasetId)}?traverseDown=true&requestEntities=DATAFLOW`
	);
}

async function getDataflow(dataflowId) {
	return api.get(
		`/dataprocessing/v2/dataflows/${encodeURIComponent(dataflowId)}`
	);
}

async function getDatasetNames(datasetIds) {
	const datasets = await api.post(
		'/data/v3/datasources/bulk?includePrivate=true',
		datasetIds
	);

	const nameMap = {};
	for (const ds of datasets.dataSources || []) {
		const id = ds.id || ds.dataSourceId;
		if (id) nameMap[id] = ds.name || ds.displayName || id;
	}
	return nameMap;
}

async function updateDataflow(dataflowId, body) {
	return api.put(
		`/dataprocessing/v1/dataflows/${encodeURIComponent(dataflowId)}`,
		body
	);
}

/**
 * Compare schemas and return differences.
 * Returns { match: boolean, missing: [], extra: [], typeMismatches: [] }
 */
function compareSchemas(oldSchema, newSchema) {
	const oldColumns = {};
	const newColumns = {};

	// Build column maps: handle both array-of-columns and object-with-columns formats
	const oldCols = Array.isArray(oldSchema)
		? oldSchema
		: oldSchema.columns || oldSchema.tables?.[0]?.columns || [];
	const newCols = Array.isArray(newSchema)
		? newSchema
		: newSchema.columns || newSchema.tables?.[0]?.columns || [];

	for (const col of oldCols) {
		const name = col.name || col.columnName || col.field;
		if (name)
			oldColumns[name] =
				col.type || col.columnType || col.dataType || 'UNKNOWN';
	}
	for (const col of newCols) {
		const name = col.name || col.columnName || col.field;
		if (name)
			newColumns[name] =
				col.type || col.columnType || col.dataType || 'UNKNOWN';
	}

	const missing = []; // in old but not in new
	const extra = []; // in new but not in old
	const typeMismatches = [];

	for (const [name, type] of Object.entries(oldColumns)) {
		if (!(name in newColumns)) {
			missing.push({ name, type });
		} else if (newColumns[name] !== type) {
			typeMismatches.push({ name, oldType: type, newType: newColumns[name] });
		}
	}

	for (const [name, type] of Object.entries(newColumns)) {
		if (!(name in oldColumns)) {
			extra.push({ name, type });
		}
	}

	return {
		match: missing.length === 0 && typeMismatches.length === 0,
		missing,
		extra,
		typeMismatches
	};
}

/**
 * Extract dataflow IDs from the lineage response that consume the given dataset.
 */
function extractConsumingDataflows(lineageData, datasetId) {
	const dataflowIds = new Set();

	for (const [key, node] of Object.entries(lineageData)) {
		// Find the DATA_SOURCE node for our target dataset
		if (node.type === 'DATA_SOURCE' && node.id === datasetId) {
			// Children of type DATAFLOW are consumers (downstream)
			for (const child of node.children || []) {
				if (child.type === 'DATAFLOW') {
					dataflowIds.add(child.id);
				}
			}
		}
	}

	return [...dataflowIds];
}

/**
 * Find the dataflow that produces (outputs) the given dataset by passing the
 * dataset UUID to the dataflows endpoint. Returns the numeric dataflow ID, or null.
 */
async function getProducingDataflowId(datasetId) {
	try {
		const data = await api.get(
			`/dataprocessing/v2/dataflows/${encodeURIComponent(datasetId)}`
		);
		return data.id ? String(data.id) : null;
	} catch (error) {
		// 404 means no dataflow produces this dataset, which is fine
		if (error.message && error.message.includes('HTTP 404')) return null;
		throw error;
	}
}

/**
 * Replace old dataset ID with new in a dataflow definition's inputs, actions,
 * and trigger settings. Updates LoadFromVault action names and input dataSourceName
 * to reflect the new dataset. Appends a version description noting the replacement.
 * Returns the count of replacements made.
 */
function replaceDatasetInDataflow(
	dataflow,
	oldId,
	newId,
	oldDatasetName,
	newDatasetName
) {
	let replacements = 0;

	// Replace in inputs (ID and name)
	if (dataflow.inputs && Array.isArray(dataflow.inputs)) {
		for (const input of dataflow.inputs) {
			if (input.dataSourceId === oldId) {
				input.dataSourceId = newId;
				input.dataSourceName = newDatasetName;
				replacements++;
			}
		}
	}

	// Replace in actions (ID and name for LoadFromVault)
	if (dataflow.actions && Array.isArray(dataflow.actions)) {
		for (const action of dataflow.actions) {
			if (action.dataSourceId === oldId) {
				action.dataSourceId = newId;
				if (action.type === 'LoadFromVault') {
					action.name = newDatasetName;
				}
				replacements++;
			}
		}
	}

	// Replace in trigger settings
	if (
		dataflow.triggerSettings?.triggers &&
		Array.isArray(dataflow.triggerSettings.triggers)
	) {
		for (const trigger of dataflow.triggerSettings.triggers) {
			if (trigger.triggerEvents && Array.isArray(trigger.triggerEvents)) {
				for (const event of trigger.triggerEvents) {
					if (event.datasetId === oldId) {
						event.datasetId = newId;
						replacements++;
					}
				}
			}
		}
	}

	// Update version description
	const versionNote = `Replaced input dataset "${oldDatasetName}" with "${newDatasetName}"`;
	if (dataflow.onboardFlowVersion) {
		const existing = dataflow.onboardFlowVersion.description || '';
		dataflow.onboardFlowVersion.description = existing
			? `${existing}\n${versionNote}`
			: versionNote;
	}

	return replacements;
}


function dataflowVersion(dataflow) {
	return dataflow.onboardFlowVersion?.versionNumber ?? null;
}

function toEntry(row) {
	if (row.dataflowId == null || row.replacements == null) return null;
	return {
		dataflowId: String(row.dataflowId),
		name: row.name,
		replacements: row.replacements,
		version: row.version ?? null
	};
}

async function checkSchemas(oldDatasetId, newDatasetId) {
	console.log('Fetching dataset schemas...');
	let oldSchema, newSchema;
	try {
		[oldSchema, newSchema] = await Promise.all([
			getDatasetSchema(oldDatasetId),
			getDatasetSchema(newDatasetId)
		]);
	} catch (error) {
		console.error(`Error fetching schemas: ${error.message}`);
		process.exit(1);
	}

	const diff = compareSchemas(oldSchema, newSchema);

	if (diff.match && diff.extra.length === 0) {
		console.log('Schemas match, proceeding.\n');
		return;
	}
	if (diff.match && diff.extra.length > 0) {
		console.log(
			'Schemas are compatible (new dataset has additional columns).\n'
		);
	} else {
		console.log('\nSchema differences detected:\n');
	}

	if (diff.missing.length > 0) {
		console.log('  Columns in OLD dataset missing from NEW dataset:');
		for (const col of diff.missing) {
			console.log(`    - ${col.name} (${col.type})`);
		}
		console.log();
	}

	if (diff.typeMismatches.length > 0) {
		console.log('  Column type mismatches:');
		for (const col of diff.typeMismatches) {
			console.log(`    - ${col.name}: ${col.oldType} -> ${col.newType}`);
		}
		console.log();
	}

	if (diff.extra.length > 0) {
		console.log('  Additional columns in NEW dataset (not in old):');
		for (const col of diff.extra) {
			console.log(`    + ${col.name} (${col.type})`);
		}
		console.log();
	}

	if (!diff.match) {
		console.log(
			'WARNING: Missing columns or type mismatches may cause dataflow failures.'
		);
		const answer = await prompt('Do you want to continue anyway? (y/N): ');
		if (answer !== 'y' && answer !== 'yes') {
			console.log('Aborted.');
			process.exit(0);
		}
		console.log();
	}
}

async function findDataflowIds(oldDatasetId, newDatasetId) {
	console.log(`Finding dataflows that use dataset ${oldDatasetId}...`);
	let dataflowIds;
	let excludedDataflowId = null;
	try {
		const [lineageData, producingId] = await Promise.all([
			getLineage(oldDatasetId),
			getProducingDataflowId(newDatasetId)
		]);
		dataflowIds = extractConsumingDataflows(lineageData, oldDatasetId);
		excludedDataflowId = producingId;
	} catch (error) {
		console.error(`Error: ${error.message}`);
		process.exit(1);
	}

	// Exclude the dataflow that produces the new dataset to avoid circular references
	if (excludedDataflowId && dataflowIds.includes(excludedDataflowId)) {
		console.log(
			`Excluding dataflow ${excludedDataflowId} (produces the new dataset)\n`
		);
		dataflowIds = dataflowIds.filter((id) => id !== excludedDataflowId);
	}
	return dataflowIds;
}

async function discover(dataflowIds, opts, logger, counts) {
	const planned = [];
	const prepared = new Map();

	for (let i = 0; i < dataflowIds.length; i++) {
		const dfId = String(dataflowIds[i]);
		let dataflow;
		try {
			dataflow = await getDataflow(dfId);
		} catch (error) {
			console.error(`  [${dfId}] failed to fetch: ${error.message}`);
			logger.addResult({
				dataflowId: dfId,
				status: 'error',
				phase: 'discover',
				error: error.message
			});
			counts.errors++;
			continue;
		}

		const version = dataflowVersion(dataflow);
		const replacements = replaceDatasetInDataflow(
			dataflow,
			opts.oldDatasetId,
			opts.newDatasetId,
			opts.oldDatasetName,
			opts.newDatasetName
		);

		if (replacements === 0) {
			console.log(`  [${dfId}] ${dataflow.name}: no references in definition, skipping`);
			logger.addResult({
				dataflowId: dfId,
				name: dataflow.name,
				status: 'skipped',
				replacements: 0
			});
			counts.skipped++;
		} else {
			planned.push({ dataflowId: dfId, name: dataflow.name, replacements, version });
			prepared.set(dfId, dataflow);
		}

		if (i < dataflowIds.length - 1) {
			await sleep(DELAY_MS);
		}
	}

	return { planned, prepared };
}

async function reapply(entry, opts) {
	const dataflow = await getDataflow(entry.dataflowId);
	const version = dataflowVersion(dataflow);
	if (entry.version != null && version != null && version !== entry.version) {
		return { drift: `version changed from ${entry.version} to ${version}` };
	}
	const replacements = replaceDatasetInDataflow(
		dataflow,
		opts.oldDatasetId,
		opts.newDatasetId,
		opts.oldDatasetName,
		opts.newDatasetName
	);
	if (replacements !== entry.replacements) {
		return { drift: `expected ${entry.replacements} reference(s), found ${replacements}` };
	}
	return { dataflow };
}

async function resolveOptions(source) {
	if (source) {
		const { oldDatasetId, newDatasetId, oldDatasetName, newDatasetName, skipSchemaCheck } =
			source.meta;
		if (!oldDatasetId || !newDatasetId) {
			console.error(`Error: ${source.relPath} does not record the old and new dataset IDs.`);
			process.exit(1);
		}
		return {
			oldDatasetId,
			newDatasetId,
			oldDatasetName: oldDatasetName || oldDatasetId,
			newDatasetName: newDatasetName || newDatasetId,
			skipSchemaCheck: Boolean(skipSchemaCheck)
		};
	}

	const oldDatasetId = argv['old-dataset-id'];
	const newDatasetId = argv['new-dataset-id'];
	if (!oldDatasetId || !newDatasetId) {
		console.error('Error: --old-dataset-id and --new-dataset-id are required\n');
		console.error(HELP_TEXT);
		process.exit(1);
	}
	if (oldDatasetId === newDatasetId) {
		console.error('Error: --old-dataset-id and --new-dataset-id must be different');
		process.exit(1);
	}

	console.log('Fetching dataset details...');
	let nameMap;
	try {
		nameMap = await getDatasetNames([oldDatasetId, newDatasetId]);
	} catch (error) {
		console.error(`Error: ${error.message}`);
		process.exit(1);
	}
	return {
		oldDatasetId,
		newDatasetId,
		oldDatasetName: nameMap[oldDatasetId] || oldDatasetId,
		newDatasetName: nameMap[newDatasetId] || newDatasetId,
		skipSchemaCheck: argv['skip-schema-check'] || false
	};
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const source = loadSource(COMMAND, argv, {
		selectionFlags: SELECTION_FLAGS,
		toEntries: toEntry
	});
	const dryRun = argv['dry-run'] || false;

	if (dryRun) {
		console.log('*** DRY RUN MODE: no changes will be made ***\n');
	}
	if (source) printSource(source);

	const opts = await resolveOptions(source);
	console.log(`  Old dataset: ${opts.oldDatasetName} (${opts.oldDatasetId})`);
	console.log(`  New dataset: ${opts.newDatasetName} (${opts.newDatasetId})\n`);

	const logger = createLogger(COMMAND, {
		dryRun,
		source,
		runMeta: {
			oldDatasetId: opts.oldDatasetId,
			newDatasetId: opts.newDatasetId,
			oldDatasetName: opts.oldDatasetName,
			newDatasetName: opts.newDatasetName,
			skipSchemaCheck: opts.skipSchemaCheck
		}
	});

	const counts = { updated: 0, skipped: 0, drifted: 0, errors: 0 };
	let planned;
	let prepared = new Map();
	let found;

	if (source) {
		planned = source.entries;
		found = planned.length;
	} else {
		if (!opts.skipSchemaCheck) {
			await checkSchemas(opts.oldDatasetId, opts.newDatasetId);
		} else {
			console.log('Skipping schema check (--skip-schema-check).\n');
		}

		const dataflowIds = await findDataflowIds(opts.oldDatasetId, opts.newDatasetId);
		if (dataflowIds.length === 0) {
			console.log('No dataflows found that use this dataset as an input.');
			process.exit(0);
		}
		found = dataflowIds.length;

		console.log(`Found ${dataflowIds.length} dataflow(s). Fetching details...\n`);
		({ planned, prepared } = await discover(dataflowIds, opts, logger, counts));
		console.log();
	}

	const writeSummary = () => {
		console.log('=== Summary ===');
		console.log(`Dataflows found: ${found}`);
		console.log(`Successfully ${dryRun ? 'would update' : 'updated'}: ${counts.updated}`);
		if (counts.skipped > 0) console.log(`Skipped (no references): ${counts.skipped}`);
		if (counts.drifted > 0) console.log(`Skipped (changed since the log): ${counts.drifted}`);
		console.log(`Errors: ${counts.errors}`);
		logger.writeRunLog({
			total: found,
			updated: counts.updated,
			skipped: counts.skipped,
			drifted: counts.drifted,
			errors: counts.errors
		});
	};

	if (planned.length === 0) {
		console.log(source ? 'The source log has nothing left to update.\n' : 'No dataflows need updating.\n');
		writeSummary();
		process.exit(counts.errors > 0 ? 1 : 0);
	}

	console.log('The following dataflows will be updated:\n');
	planned.forEach((entry, i) => {
		console.log(`  ${i + 1}. [${entry.dataflowId}] ${entry.name} (${entry.replacements} reference(s))`);
	});
	console.log();

	if (dryRun) {
		for (const entry of planned) {
			logger.addResult({ ...entry, status: 'dry-run' });
			counts.updated++;
		}
		writeSummary();
		console.log(`\nRun "node cli.js ${COMMAND} --from-dry-run" to apply this plan.`);
		process.exit(counts.errors > 0 ? 1 : 0);
	}

	const question = `Proceed with updating ${planned.length} dataflow(s)? (y/N): `;
	const confirmed = source
		? await confirmSource(question, argv)
		: ['y', 'yes'].includes(await prompt(question));
	if (!confirmed) {
		console.log('Aborted.');
		process.exit(0);
	}
	console.log();

	logger.beginExecution(planned, (row) => String(row.dataflowId));

	for (let i = 0; i < planned.length; i++) {
		const entry = planned[i];
		console.log(`[${i + 1}/${planned.length}] ${entry.name} (${entry.dataflowId})`);

		try {
			let dataflow = prepared.get(entry.dataflowId);
			if (!dataflow) {
				const result = await reapply(entry, opts);
				if (result.drift) {
					console.log(`  Skipped: ${result.drift}\n`);
					logger.addResult({ ...entry, status: 'skipped', reason: 'drift', detail: result.drift });
					counts.drifted++;
					continue;
				}
				dataflow = result.dataflow;
			}
			await updateDataflow(entry.dataflowId, dataflow);
			console.log(`  Updated ${entry.replacements} reference(s)\n`);
			logger.addResult({ ...entry, status: 'updated' });
			counts.updated++;
		} catch (error) {
			console.error(`  Error: ${error.message}\n`);
			logger.addResult({ ...entry, status: 'error', error: error.message });
			counts.errors++;
		}

		if (i < planned.length - 1) {
			await sleep(DELAY_MS);
		}
	}

	writeSummary();

	if (counts.errors > 0) {
		console.error(
			`\nSome dataflows failed to update. Run "node cli.js ${COMMAND} --retry-errors" to retry them.`
		);
		process.exit(1);
	} else {
		console.log('\nAll dataflows were processed successfully!');
	}
}

process.on('uncaughtException', (error) => {
	console.error('Error:', error.message);
	process.exit(1);
});

main();
