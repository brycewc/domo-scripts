/**
 * Unshare content in bulk using a CSV or JSON file of content IDs
 *
 * Usage:
 *   # CSV with mixed types — needs the type column
 *   node cli.js bulk-unshare-content --file "content.csv" --user "1250228141"
 *
 *   # CSV that is all one type — no type column needed, --content-type applies to every row
 *   node cli.js bulk-unshare-content --file "cards.csv" --user "1250228141" --content-type "card"
 *
 *   # CSV with custom column names
 *   node cli.js bulk-unshare-content --file "items.csv" --group "12345" \
 *     --id-column "ID" --type-column "Type"
 *
 *   # JSON file (array of integers) — requires --content-type
 *   node cli.js bulk-unshare-content --file "card-ids.json" --user "1250228141" --content-type "card"
 *   node cli.js bulk-unshare-content --file "dataset-ids.json" --group "12345" --content-type "dataset"
 *
 * Options:
 *   --file           CSV or JSON file with content IDs (required)
 *   --user           User ID to unshare from (required if --group is not set)
 *   --group          Group ID to unshare from (required if --user is not set)
 *   --content-type   Content type: card, badge, page, dataApp, alert, dataset.
 *                    Required for JSON files. For CSV, required when no type column is present;
 *                    otherwise used as the fallback when a row's type cell is empty.
 *   --id-column      CSV column with object IDs (default: "Object ID")
 *   --type-column    CSV column with object type per row (default: "Object Type ID").
 *                    Optional when --content-type is set and the CSV is single-type.
 *   --verbose        Log every batch (success and failure) to the run log. By default only
 *                    failures are logged.
 *   --skip-invalid-datasets
 *                    Before unsharing, look up every dataset ID and drop any that don't
 *                    exist (one bad ID otherwise fails its whole batch of 50). Datasets only;
 *                    the dropped IDs are recorded in the run log.
 *
 * Type values are case-insensitive. Aliases accepted: CARD → badge, DATA_SOURCE / DATASET → dataset.
 *
 * Datasets are unshared via /data/v1/ui/bulk/share with accessLevel=NONE.
 * dataApps are unshared via /content/v1/dataapps/share/remove (with a group-owner workaround).
 * Other content types use /content/v1/share/bulk/{type}/{recipient}/{id}. All in batches of 50.
 *
 * Run logs are written to logs/bulk-unshare-content/. By default only failed batches are
 * recorded (so invalid IDs can be recovered afterward); pass --verbose to also log successes.
 */

const { api, readCSV, config, showHelp, createLogger, partitionExistingDatasets } = require('../lib');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-unshare-content [options]

Unshare content in bulk using a CSV or JSON file of content IDs.

Options:
  --file           CSV or JSON file with content IDs (required)
  --user           User ID to unshare from (required if --group is not set)
  --group          Group ID to unshare from (required if --user is not set)
  --content-type   Content type: card, badge, page, dataApp, alert, dataset.
                   Required for JSON files. For CSV, required when no type column is
                   present; otherwise used as fallback when a row's type cell is empty.
  --id-column      CSV column with object IDs (default: "Object ID")
  --type-column    CSV column with object type per row (default: "Object Type ID").
                   Optional when --content-type is set and the CSV is single-type.
  --verbose        Log every batch (success and failure) to the run log. By default
                   only failures are logged.
  --skip-invalid-datasets
                   Before unsharing, look up every dataset ID and drop any that don't
                   exist (datasets only). Dropped IDs are recorded in the run log.

Type values are case-insensitive. Aliases: CARD → badge, DATA_SOURCE / DATASET → dataset.

Datasets are unshared via /data/v1/ui/bulk/share with accessLevel=NONE.
dataApps are unshared via /content/v1/dataapps/share/remove (with a group-owner workaround).
Other content types use /content/v1/share/bulk/{type}/{recipient}/{id}. All in batches of 50.`;

const VALID_CONTENT_TYPES = ['badge', 'page', 'dataapp', 'alert', 'dataset'];

function normalizeContentType(raw) {
	if (raw == null || raw === '') return null;
	const lower = String(raw).trim().toLowerCase();
	if (lower === 'card') return 'badge';
	if (lower === 'data_source' || lower === 'dataset') return 'dataset';
	return VALID_CONTENT_TYPES.includes(lower) ? lower : null;
}

async function main() {
	showHelp(argv, HELP_TEXT);

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
	const recipient = { type: recipientType, id: recipientId };

	const idColumn = argv['id-column'] || 'Object ID';
	const typeColumn = argv['type-column'] || 'Object Type ID';

	let contentTypeFallback = null;
	if (argv['content-type']) {
		contentTypeFallback = normalizeContentType(argv['content-type']);
		if (!contentTypeFallback) {
			throw new Error(
				'Invalid --content-type. Must be one of: card, badge, page, dataApp, alert, dataset'
			);
		}
	}

	const fileExtension = argv.file.toLowerCase().split('.').pop();
	let items;

	if (fileExtension === 'csv') {
		const records = readCSV(argv.file);
		if (records.length === 0) throw new Error('CSV file has no rows');
		const columns = Object.keys(records[0]);
		if (!columns.includes(idColumn)) {
			throw new Error(
				`ID column "${idColumn}" not found in CSV. Available: ${columns.join(', ')}`
			);
		}
		const hasTypeColumn = columns.includes(typeColumn);
		if (!hasTypeColumn && !contentTypeFallback) {
			throw new Error(
				`Type column "${typeColumn}" not found in CSV and --content-type is not set. ` +
					`Provide --content-type or a CSV with a type column. Available columns: ${columns.join(', ')}`
			);
		}

		items = [];
		for (const row of records) {
			const id = row[idColumn];
			if (!id) continue;
			const rawType = hasTypeColumn ? row[typeColumn] : null;
			const typeVal = normalizeContentType(rawType) || contentTypeFallback;
			if (!typeVal) {
				console.warn(
					`  Skipping row with id=${id}: unknown type "${rawType}" and no --content-type fallback`
				);
				continue;
			}
			items.push({ id: String(id), type: typeVal });
		}
		console.log(
			`Loaded ${items.length} items from ${argv.file} (id column: ${idColumn}${hasTypeColumn ? `, type column: ${typeColumn}` : ''})`
		);
	} else if (fileExtension === 'json') {
		if (!contentTypeFallback) {
			throw new Error(
				'--content-type parameter is required for JSON files: card, badge, page, dataApp, alert, dataset'
			);
		}

		const data = fs.readFileSync(argv.file, 'utf8');
		const contentIds = JSON.parse(data);
		if (!Array.isArray(contentIds)) {
			throw new Error('JSON file must contain an array of integers');
		}
		const invalidIds = contentIds.filter((id) => !Number.isInteger(id));
		if (invalidIds.length > 0) {
			throw new Error(
				`Invalid content IDs found (must be integers): ${invalidIds
					.slice(0, 5)
					.join(', ')}${invalidIds.length > 5 ? '...' : ''}`
			);
		}
		items = contentIds.map((id) => ({ id: String(id), type: contentTypeFallback }));
		console.log(
			`Loaded ${items.length} ${argv['content-type']} IDs from ${argv.file}`
		);
	} else {
		throw new Error('File must have .csv or .json extension');
	}

	// Group items by type
	const itemsByType = {};
	for (const item of items) {
		if (!itemsByType[item.type]) itemsByType[item.type] = [];
		itemsByType[item.type].push(item);
	}

	const batchSize = 50;
	let successCount = 0;
	let errorCount = 0;

	let datasetItems = itemsByType.dataset || [];
	const dataappItems = itemsByType.dataapp || [];
	const otherTypes = Object.keys(itemsByType).filter(
		(t) => t !== 'dataset' && t !== 'dataapp'
	);

	const skipInvalidDatasets = Boolean(argv['skip-invalid-datasets']);
	let invalidDatasetIds = [];
	if (skipInvalidDatasets && datasetItems.length > 0) {
		console.log(
			`\nValidating ${datasetItems.length} dataset ID(s) before unsharing...`
		);
		const { invalid } = await partitionExistingDatasets(
			api,
			datasetItems.map((it) => it.id),
			{
				onProgress: (n, total, validCount) =>
					console.log(`  Checked chunk ${n}/${total} (${validCount} valid)`)
			}
		);
		invalidDatasetIds = invalid;
		if (invalid.length > 0) {
			const invalidSet = new Set(invalid);
			datasetItems = datasetItems.filter(
				(it) => !invalidSet.has(String(it.id))
			);
			console.log(
				`  Dropped ${invalid.length} invalid dataset ID(s); ${datasetItems.length} remain.`
			);
		} else {
			console.log('  All dataset IDs are valid.');
		}
	}

	const verbose = Boolean(argv.verbose);
	const logger = createLogger('bulk-unshare-content', {
		debugMode: false,
		dryRun: false,
		runMeta: {
			file: argv.file,
			recipient,
			idColumn,
			typeColumn,
			contentTypeFallback,
			verbose,
			skipInvalidDatasets,
			invalidDatasetCount: invalidDatasetIds.length,
			invalidDatasetIds,
			totalItems: items.length,
			datasetItemCount: datasetItems.length,
			dataappItemCount: dataappItems.length,
			otherItemCount: otherTypes.reduce(
				(n, t) => n + itemsByType[t].length,
				0
			)
		}
	});

	// Datasets — /data/v1/ui/bulk/share with accessLevel=NONE
	if (datasetItems.length > 0) {
		console.log(
			`\nUnsharing ${datasetItems.length} datasets from ${recipientType} ${recipientId}...`
		);
		console.log('Processing datasets in batches of 50...');

		const totalBatches = Math.ceil(datasetItems.length / batchSize);
		for (let start = 0; start < datasetItems.length; start += batchSize) {
			const batch = datasetItems.slice(start, start + batchSize);
			const batchNumber = Math.floor(start / batchSize) + 1;

			console.log(
				`  Processing dataset batch ${batchNumber}/${totalBatches} (${batch.length} datasets)...`
			);

			const body = {
				bulkItems: {
					ids: batch.map((it) => String(it.id)),
					type: 'DATA_SOURCE'
				},
				dataSourceShareEntity: {
					permissions: [
						{
							accessLevel: 'NONE',
							id: String(recipientId),
							type: recipientType.toUpperCase()
						}
					],
					sendEmail: false,
					message: 'Bulk unsharing from script.'
				}
			};

			try {
				const result = await api.post('/data/v1/ui/bulk/share', body);
				const failed = (result && result.failed) || {};
				const failedIds = Object.keys(failed);

				if (failedIds.length > 0) {
					console.error(
						`  Dataset batch ${batchNumber} partial failure: ${failedIds.length}/${batch.length} failed`
					);
					errorCount++;
					logger.addResult({
						kind: 'dataset',
						recipient,
						accessLevel: 'NONE',
						batchNumber,
						totalBatches,
						items: batch,
						status: 'partial-failure',
						failed,
						failedIds
					});
				} else {
					console.log(
						`  Dataset batch ${batchNumber} success (${batch.length} datasets)`
					);
					successCount++;
					if (verbose) {
						logger.addResult({
							kind: 'dataset',
							recipient,
							accessLevel: 'NONE',
							batchNumber,
							totalBatches,
							items: batch,
							status: 'success',
							response: result
						});
					}
				}
			} catch (error) {
				console.error(`  Dataset batch ${batchNumber} error: ${error.message}`);
				errorCount++;
				logger.addResult({
					kind: 'dataset',
					recipient,
					accessLevel: 'NONE',
					batchNumber,
					totalBatches,
					items: batch,
					status: 'error',
					error: error.message
				});
			}

			if (start + batchSize < datasetItems.length) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	}

	// DataApps — owner-flip workaround + /content/v1/dataapps/share/remove
	if (dataappItems.length > 0) {
		console.log(
			`\nUnsharing ${dataappItems.length} dataApps from ${recipientType} ${recipientId}...`
		);

		const ownerBody = {
			note: '',
			entityIds: dataappItems.map((it) => String(it.id)),
			owners: [{ type: 'GROUP', id: 144874194 }],
			sendEmail: false
		};

		console.log('=== Adding group 144874194 as owner to all dataApps ===');
		try {
			await api.put('/content/v1/dataapps/bulk/owners', ownerBody);
			console.log(
				'Successfully added group 144874194 as owner to all dataApps'
			);
		} catch (error) {
			console.error(`Failed to add owner: ${error.message}`);
		}

		console.log('Processing dataApps in batches of 50...');
		const totalBatches = Math.ceil(dataappItems.length / batchSize);
		for (let start = 0; start < dataappItems.length; start += batchSize) {
			const batch = dataappItems.slice(start, start + batchSize);
			const batchNumber = Math.floor(start / batchSize) + 1;

			console.log(
				`  Processing dataApp batch ${batchNumber}/${totalBatches} (${batch.length} dataApps)...`
			);

			try {
				const result = await api.post('/content/v1/dataapps/share/remove', {
					dataAppIds: batch.map((it) => String(it.id)),
					recipients: [
						{
							id: parseInt(recipientId),
							type: recipientType
						}
					]
				});
				console.log(
					`  DataApp batch ${batchNumber} success:`,
					result ? JSON.stringify(result, null, 2) : 'No response body'
				);
				successCount++;
				if (verbose) {
					logger.addResult({
						kind: 'dataapp',
						recipient,
						batchNumber,
						totalBatches,
						items: batch,
						status: 'success',
						response: result
					});
				}
			} catch (error) {
				console.error(`  DataApp batch ${batchNumber} error: ${error.message}`);
				errorCount++;
				logger.addResult({
					kind: 'dataapp',
					recipient,
					batchNumber,
					totalBatches,
					items: batch,
					status: 'error',
					error: error.message
				});
			}

			if (start + batchSize < dataappItems.length) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}

		console.log('=== Removing group 144874194 as owner from all dataApps ===');
		try {
			await api.post('/content/v1/dataapps/bulk/owners/remove', {
				entityIds: ownerBody.entityIds,
				owners: ownerBody.owners
			});
			console.log(
				'Successfully removed group 144874194 as owner from all dataApps'
			);
		} catch (error) {
			console.error(`Failed to remove owner: ${error.message}`);
		}
	}

	// Other types — /content/v1/share/bulk/{type}/{recipient}/{id}
	for (const type of otherTypes) {
		const typeItems = itemsByType[type];
		const ids = typeItems
			.map((it) => parseInt(it.id, 10))
			.filter((id) => !isNaN(id));

		const endpoint = `/content/v1/share/bulk/${type}/${recipientType}/${recipientId}`;

		console.log(
			`\nUnsharing ${ids.length} ${type}s from ${recipientType} ${recipientId}...`
		);
		console.log(`Endpoint: ${config.baseUrl}${endpoint}`);
		console.log('Processing in batches of 50...');

		const totalBatches = Math.ceil(ids.length / batchSize);
		for (let start = 0; start < ids.length; start += batchSize) {
			const batch = ids.slice(start, start + batchSize);
			const batchNumber = Math.floor(start / batchSize) + 1;

			console.log(
				`  Processing ${type} batch ${batchNumber}/${totalBatches} (${batch.length} ${type}s)...`
			);

			try {
				const result = await api.post(endpoint, batch);
				console.log(
					`  Batch ${batchNumber} success:`,
					result ? JSON.stringify(result, null, 2) : 'No response body'
				);
				successCount++;
				if (verbose) {
					logger.addResult({
						kind: type,
						recipient,
						batchNumber,
						totalBatches,
						items: batch,
						status: 'success',
						response: result
					});
				}
			} catch (error) {
				console.error(`  Batch ${batchNumber} error: ${error.message}`);
				errorCount++;
				logger.addResult({
					kind: type,
					recipient,
					batchNumber,
					totalBatches,
					items: batch,
					status: 'error',
					error: error.message
				});
			}

			if (start + batchSize < ids.length) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	}

	// Summary
	const otherItemCount = otherTypes.reduce(
		(n, t) => n + itemsByType[t].length,
		0
	);
	console.log('\n=== Summary ===');
	console.log(
		`Total items processed: ${datasetItems.length + dataappItems.length + otherItemCount}`
	);
	if (datasetItems.length > 0) console.log(`  Datasets: ${datasetItems.length}`);
	if (dataappItems.length > 0) console.log(`  DataApps: ${dataappItems.length}`);
	for (const type of otherTypes) {
		console.log(`  ${type}: ${itemsByType[type].length}`);
	}
	if (invalidDatasetIds.length > 0) {
		console.log(`Skipped invalid datasets: ${invalidDatasetIds.length}`);
	}
	console.log(`Successful batches: ${successCount}`);
	console.log(`Failed batches: ${errorCount}`);

	logger.writeRunLog({
		totalItems: items.length,
		datasetItems: datasetItems.length,
		dataappItems: dataappItems.length,
		otherItems: otherItemCount,
		skippedInvalidDatasets: invalidDatasetIds.length,
		successfulBatches: successCount,
		failedBatches: errorCount
	});

	if (errorCount > 0) {
		console.error('\nSome batches failed. Check the run log for details.');
		process.exit(1);
	} else {
		console.log('\nAll batches completed successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
