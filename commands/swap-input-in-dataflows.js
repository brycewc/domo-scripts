/**
 * Replace a dataset in all dataflows that use it
 *
 * Finds every dataflow that uses the old dataset as an input, validates schema
 * compatibility between old and new datasets, then updates each dataflow to
 * reference the new dataset instead.
 *
 * Usage:
 *   node cli.js swap-input-in-dataflows --old-dataset-id "<uuid>" --new-dataset-id "<uuid>"
 *   node cli.js swap-input-in-dataflows --old-dataset-id "<uuid>" --new-dataset-id "<uuid>" --dry-run
 *   node cli.js swap-input-in-dataflows --old-dataset-id "<uuid>" --new-dataset-id "<uuid>" --skip-schema-check
 *
 * Options:
 *   --old-dataset-id    The dataset ID to find and replace (required)
 *   --new-dataset-id    The dataset ID to replace it with (required)
 *   --dry-run           Show what would change without making updates
 *   --skip-schema-check Skip the schema comparison step
 */

const api = require('../lib/api');
const { showHelp } = require('../lib/help');
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js swap-input-in-dataflows [options]

Options:
  --old-dataset-id    The dataset ID to find and replace (required)
  --new-dataset-id    The dataset ID to replace it with (required)
  --dry-run           Show what would change without making updates
  --skip-schema-check Skip the schema comparison step`;

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

	// Build column maps — handle both array-of-columns and object-with-columns formats
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
		// 404 means no dataflow produces this dataset — that's fine
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

async function main() {
	showHelp(argv, HELP_TEXT);

	const oldDatasetId = argv['old-dataset-id'];
	const newDatasetId = argv['new-dataset-id'];
	const dryRun = argv['dry-run'] || false;
	const skipSchemaCheck = argv['skip-schema-check'] || false;

	if (!oldDatasetId || !newDatasetId) {
		console.error('Error: --old-dataset-id and --new-dataset-id are required\n');
		console.error(HELP_TEXT);
		process.exit(1);
	}

	if (oldDatasetId === newDatasetId) {
		console.error('Error: --old-dataset-id and --new-dataset-id must be different');
		process.exit(1);
	}

	if (dryRun) {
		console.log('*** DRY RUN MODE — no changes will be made ***\n');
	}

	// Step 1: Fetch dataset names for verification
	console.log('Fetching dataset details...');
	let oldDatasetName, newDatasetName;
	try {
		const nameMap = await getDatasetNames([oldDatasetId, newDatasetId]);
		oldDatasetName = nameMap[oldDatasetId] || oldDatasetId;
		newDatasetName = nameMap[newDatasetId] || newDatasetId;
	} catch (error) {
		console.error(`Error: ${error.message}`);
		process.exit(1);
	}

	console.log(`  Old dataset: ${oldDatasetName} (${oldDatasetId})`);
	console.log(`  New dataset: ${newDatasetName} (${newDatasetId})\n`);

	// Step 2: Schema validation
	if (!skipSchemaCheck) {
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
			console.log('Schemas match — proceeding.\n');
		} else {
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
	} else {
		console.log('Skipping schema check (--skip-schema-check).\n');
	}

	// Step 3: Find dataflows using the old dataset and the producing dataflow of the new dataset
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

	if (dataflowIds.length === 0) {
		console.log('No dataflows found that use this dataset as an input.');
		process.exit(0);
	}

	// Step 4: Fetch all dataflow details and display for confirmation
	console.log(`Found ${dataflowIds.length} dataflow(s). Fetching details...\n`);

	const dataflows = [];
	for (let i = 0; i < dataflowIds.length; i++) {
		const dfId = dataflowIds[i];
		try {
			const dataflow = await getDataflow(dfId);
			dataflows.push({ id: dfId, dataflow });
		} catch (error) {
			console.error(`  Failed to fetch dataflow ${dfId}: ${error.message}`);
			dataflows.push({ id: dfId, dataflow: null, error: error.message });
		}
		if (i < dataflowIds.length - 1) {
			await sleep(DELAY_MS);
		}
	}

	console.log('The following dataflows will be updated:\n');
	for (let i = 0; i < dataflows.length; i++) {
		const { id, dataflow, error } = dataflows[i];
		if (dataflow) {
			console.log(`  ${i + 1}. [${id}] ${dataflow.name}`);
		} else {
			console.log(`  ${i + 1}. [${id}] (failed to fetch: ${error})`);
		}
	}
	console.log();

	if (!dryRun) {
		const answer = await prompt(
			`Proceed with updating ${dataflows.filter((d) => d.dataflow).length} dataflow(s)? (y/N): `
		);
		if (answer !== 'y' && answer !== 'yes') {
			console.log('Aborted.');
			process.exit(0);
		}
		console.log();
	}

	// Step 5: Replace dataset and update each dataflow
	let successCount = 0;
	let errorCount = 0;
	let skipCount = 0;

	for (let i = 0; i < dataflows.length; i++) {
		const { id: dfId, dataflow } = dataflows[i];
		console.log(
			`[${i + 1}/${dataflows.length}] Processing dataflow ${dfId}...`
		);

		if (!dataflow) {
			console.error('  Skipped (failed to fetch earlier)\n');
			errorCount++;
			continue;
		}

		console.log(`  Name: ${dataflow.name}`);

		const replacements = replaceDatasetInDataflow(
			dataflow,
			oldDatasetId,
			newDatasetId,
			oldDatasetName,
			newDatasetName
		);

		if (replacements === 0) {
			console.log(
				'  No references to old dataset found in definition — skipping.\n'
			);
			skipCount++;
			continue;
		}

		console.log(`  Found ${replacements} reference(s) to replace`);

		if (dryRun) {
			console.log('  (dry run) Would update this dataflow.\n');
			successCount++;
		} else {
			try {
				await updateDataflow(dfId, dataflow);
				console.log('  Successfully updated\n');
				successCount++;
			} catch (error) {
				console.error(`  Error: ${error.message}\n`);
				errorCount++;
			}
		}

		if (i < dataflows.length - 1) {
			await sleep(DELAY_MS);
		}
	}

	// Summary
	console.log('=== Summary ===');
	console.log(`Dataflows found: ${dataflows.length}`);
	console.log(
		`Successfully ${dryRun ? 'would update' : 'updated'}: ${successCount}`
	);
	if (skipCount > 0) console.log(`Skipped (no references): ${skipCount}`);
	console.log(`Errors: ${errorCount}`);

	if (errorCount > 0) {
		console.error(
			'\nSome dataflows failed to update. Check the error messages above.'
		);
		process.exit(1);
	} else {
		console.log(
			`\nAll dataflows ${dryRun ? 'would be' : 'were'} processed successfully!`
		);
	}
}

process.on('uncaughtException', (error) => {
	console.error('Error:', error.message);
	process.exit(1);
});

main();
