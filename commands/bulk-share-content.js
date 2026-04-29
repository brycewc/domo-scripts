/**
 * Share content in bulk using a CSV or JSON file of content IDs
 *
 * Usage:
 *   # CSV with mixed types — needs the type column
 *   node cli.js bulk-share-content --file "content.csv" --user "1250228141"
 *
 *   # CSV that is all one type — no type column needed, --content-type applies to every row
 *   node cli.js bulk-share-content --file "cards.csv" --user "1250228141" --content-type "card"
 *
 *   # CSV with custom column names
 *   node cli.js bulk-share-content --file "items.csv" --group "12345" \
 *     --id-column "ID" --type-column "Type"
 *
 *   # CSV of datasets with a per-row access level column
 *   node cli.js bulk-share-content --file "datasets.csv" --user "1250228141" \
 *     --content-type "dataset" --access-level-column "Access"
 *
 *   # CSV with a per-row user column (each row shares to a different user)
 *   node cli.js bulk-share-content --file "items.csv" --user-column "User ID"
 *
 *   # JSON file (array of integers) — requires --content-type
 *   node cli.js bulk-share-content --file "card-ids.json" --user "1250228141" --content-type "card"
 *   node cli.js bulk-share-content --file "dataset-ids.json" --user "1250228141" --content-type "dataset" --access-level "CAN_VIEW"
 *
 * Options:
 *   --file                  CSV or JSON file with content IDs (required)
 *   --user                  User ID to share with (fallback when --user-column is unset/empty;
 *                           required if --group and --user-column are not set)
 *   --group                 Group ID to share with (required if --user and --user-column are not set)
 *   --content-type          Content type: card, badge, page, dataApp, alert, dataset.
 *                           Required for JSON files. For CSV, required when no type column is present;
 *                           otherwise used as the fallback when a row's type cell is empty.
 *   --id-column             CSV column with object IDs (default: "Object ID")
 *   --type-column           CSV column with object type per row (default: "Object Type ID").
 *                           Optional when --content-type is set and the CSV is single-type.
 *   --user-column           CSV column with per-row user ID. Overrides --user/--group for any row
 *                           that has a value; rows without a value fall back to --user or --group.
 *   --access-level          Access level for dataset sharing: CAN_VIEW, CAN_SHARE, CAN_EDIT, OWNER
 *                           (default: CAN_VIEW)
 *   --access-level-column   CSV column with per-row access level (datasets only). Overrides --access-level
 *                           for any row that has a value.
 *   --verbose               Log every batch (success and failure) to the run log. By default only
 *                           failures are logged. For dataset batches, a non-empty `failed` object in
 *                           the API response counts as a failure.
 *
 * Type values are case-insensitive. Aliases accepted: CARD → badge, DATA_SOURCE / DATASET → dataset.
 *
 * Datasets are shared via /data/v1/ui/bulk/share, batched per access level.
 * All other content types are batched through /content/v1/share.
 */

const api = require('../lib/api');
const { readCSV } = require('../lib/csv');
const { showHelp } = require('../lib/help');
const { createLogger } = require('../lib/log');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-share-content [options]

Share content in bulk using a CSV or JSON file of content IDs.

Options:
  --file                  CSV or JSON file with content IDs (required)
  --user                  User ID to share with (fallback when --user-column is unset/empty;
                          required if --group and --user-column are not set)
  --group                 Group ID to share with (required if --user and --user-column are not set)
  --content-type          Content type: card, badge, page, dataApp, alert, dataset.
                          Required for JSON files. For CSV, required when no type column is
                          present; otherwise used as fallback when a row's type cell is empty.
  --id-column             CSV column with object IDs (default: "Object ID")
  --type-column           CSV column with object type per row (default: "Object Type ID").
                          Optional when --content-type is set and the CSV is single-type.
  --user-column           CSV column with per-row user ID. Overrides --user/--group for any row
                          that has a value; rows without a value fall back to --user or --group.
  --access-level          Access level for dataset sharing: CAN_VIEW, CAN_SHARE, CAN_EDIT, OWNER
                          (default: CAN_VIEW)
  --access-level-column   CSV column with per-row access level (datasets only). Overrides
                          --access-level for any row that has a value.
  --verbose               Log every batch (success and failure) to the run log. By default only
                          failures are logged. For dataset batches, a non-empty \`failed\` object
                          in the API response counts as a failure.

Type values are case-insensitive. Aliases: CARD → badge, DATA_SOURCE / DATASET → dataset.`;

const VALID_CONTENT_TYPES = ['card', 'badge', 'page', 'dataApp', 'alert', 'dataset'];
const VALID_ACCESS_LEVELS = ['CAN_VIEW', 'CAN_SHARE', 'CAN_EDIT', 'OWNER'];

function normalizeContentType(raw) {
	if (raw == null || raw === '') return null;
	const lower = String(raw).trim().toLowerCase();
	if (lower === 'card') return 'badge';
	if (lower === 'data_source' || lower === 'dataset') return 'dataset';
	const match = VALID_CONTENT_TYPES.find((t) => t.toLowerCase() === lower);
	return match || null;
}

function normalizeAccessLevel(raw) {
	if (raw == null || raw === '') return null;
	const upper = String(raw).trim().toUpperCase();
	return VALID_ACCESS_LEVELS.includes(upper) ? upper : null;
}

async function main() {
	showHelp(argv, HELP_TEXT);

	if (!argv.file) {
		throw new Error('--file parameter is required');
	}
	if (argv.user && argv.group) {
		throw new Error('Cannot specify both --user and --group parameters');
	}

	const userColumn = argv['user-column'] || null;
	if (!argv.user && !argv.group && !userColumn) {
		throw new Error('Either --user, --group, or --user-column parameter is required');
	}

	const fallbackRecipient = argv.user
		? { type: 'user', id: argv.user }
		: argv.group
			? { type: 'group', id: argv.group }
			: null;

	const defaultAccessLevel = normalizeAccessLevel(argv['access-level'] || 'CAN_VIEW');
	if (!defaultAccessLevel) {
		throw new Error(
			`Invalid --access-level. Must be one of: ${VALID_ACCESS_LEVELS.join(', ')}`
		);
	}

	const idColumn = argv['id-column'] || 'Object ID';
	const typeColumn = argv['type-column'] || 'Object Type ID';
	const accessLevelColumn = argv['access-level-column'] || null;

	let contentTypeFallback = null;
	if (argv['content-type']) {
		contentTypeFallback = normalizeContentType(argv['content-type']);
		if (!contentTypeFallback) {
			throw new Error(
				`Invalid --content-type. Must be one of: ${VALID_CONTENT_TYPES.join(', ')}, card`
			);
		}
	}

	const fileExtension = argv.file.toLowerCase().split('.').pop();
	let fileJson;

	if (fileExtension === 'csv') {
		const records = readCSV(argv.file);
		if (records.length === 0) throw new Error('CSV file has no rows');
		const columns = Object.keys(records[0]);
		if (!columns.includes(idColumn)) {
			throw new Error(`ID column "${idColumn}" not found in CSV. Available: ${columns.join(', ')}`);
		}
		const hasTypeColumn = columns.includes(typeColumn);
		if (!hasTypeColumn && !contentTypeFallback) {
			throw new Error(
				`Type column "${typeColumn}" not found in CSV and --content-type is not set. ` +
					`Provide --content-type or a CSV with a type column. Available columns: ${columns.join(', ')}`
			);
		}
		if (accessLevelColumn && !columns.includes(accessLevelColumn)) {
			throw new Error(
				`Access level column "${accessLevelColumn}" not found in CSV. Available: ${columns.join(', ')}`
			);
		}
		if (userColumn && !columns.includes(userColumn)) {
			throw new Error(
				`User column "${userColumn}" not found in CSV. Available: ${columns.join(', ')}`
			);
		}

		fileJson = [];
		for (const row of records) {
			const id = row[idColumn];
			if (!id) continue;
			const rawType = hasTypeColumn ? row[typeColumn] : null;
			const typeVal = normalizeContentType(rawType) || contentTypeFallback;
			if (!typeVal) {
				console.warn(`  Skipping row with id=${id}: unknown type "${rawType}" and no --content-type fallback`);
				continue;
			}

			let rowAccessLevel = defaultAccessLevel;
			if (accessLevelColumn && row[accessLevelColumn]) {
				const normalized = normalizeAccessLevel(row[accessLevelColumn]);
				if (!normalized) {
					throw new Error(
						`Invalid access level "${row[accessLevelColumn]}" in column "${accessLevelColumn}" for id=${id}. ` +
							`Must be one of: ${VALID_ACCESS_LEVELS.join(', ')}`
					);
				}
				rowAccessLevel = normalized;
			}

			let recipient = fallbackRecipient;
			if (userColumn && row[userColumn]) {
				recipient = { type: 'user', id: String(row[userColumn]).trim() };
			}
			if (!recipient) {
				console.warn(`  Skipping row with id=${id}: no user in column "${userColumn}" and no --user/--group fallback`);
				continue;
			}

			fileJson.push({
				id: String(id),
				type: typeVal,
				accessLevel: rowAccessLevel,
				recipient
			});
		}
	} else if (fileExtension === 'json') {
		if (!contentTypeFallback) {
			throw new Error(
				`--content-type parameter is required for JSON files: ${VALID_CONTENT_TYPES.join(', ')}, card`
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

		if (!fallbackRecipient) {
			throw new Error('JSON files require --user or --group (--user-column only applies to CSV)');
		}

		fileJson = contentIds.map((id) => ({
			id: String(id),
			type: contentTypeFallback,
			accessLevel: defaultAccessLevel,
			recipient: fallbackRecipient
		}));

		console.log(
			`Loaded ${contentIds.length} ${argv['content-type']} IDs from ${argv.file}`
		);
	} else {
		throw new Error('File must have .csv or .json extension');
	}

	const datasetItems = fileJson.filter((item) => item.type === 'dataset');
	const contentItems = fileJson.filter((item) => item.type !== 'dataset');

	const verbose = Boolean(argv.verbose);
	const logger = createLogger('bulk-share-content', {
		debugMode: false,
		dryRun: false,
		runMeta: {
			file: argv.file,
			fallbackRecipient,
			userColumn,
			idColumn,
			typeColumn,
			contentTypeFallback,
			accessLevelColumn,
			defaultAccessLevel,
			verbose,
			totalItems: fileJson.length,
			contentItemCount: contentItems.length,
			datasetItemCount: datasetItems.length
		}
	});

	let successCount = 0;
	let errorCount = 0;

	if (contentItems.length > 0) {
		// /content/v1/share takes a single recipient list per call, so group by recipient.
		const contentByRecipient = {};
		for (const item of contentItems) {
			const key = `${item.recipient.type}:${item.recipient.id}`;
			if (!contentByRecipient[key]) contentByRecipient[key] = { recipient: item.recipient, items: [] };
			contentByRecipient[key].items.push(item);
		}

		const batchSize = 50;
		const recipientKeys = Object.keys(contentByRecipient);

		console.log(
			`Processing ${contentItems.length} content items across ${recipientKeys.length} recipient(s) in batches of ${batchSize}...`
		);

		for (const key of recipientKeys) {
			const { recipient, items } = contentByRecipient[key];
			const totalBatches = Math.ceil(items.length / batchSize);

			console.log(`\n  Recipient ${recipient.type}=${recipient.id}: ${items.length} item(s)`);

			for (let start = 0; start < items.length; start += batchSize) {
				const batch = items.slice(start, start + batchSize);
				const batchNumber = Math.floor(start / batchSize) + 1;

				console.log(
					`  Processing batch ${batchNumber}/${totalBatches} (${batch.length} items)...`
				);

				const body = {
					resources: batch.map((item) => ({ id: item.id, type: item.type })),
					recipients: [
						{
							type: recipient.type,
							id: recipient.id
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
						`  Batch ${batchNumber} success:`,
						JSON.stringify(result, null, 2)
					);
					successCount++;
					if (verbose) {
						logger.addResult({
							kind: 'content',
							recipient,
							batchNumber,
							totalBatches,
							items: batch,
							status: 'success',
							response: result
						});
					}
				} catch (error) {
					console.error(`  Batch ${batchNumber} error:`, error.message);
					errorCount++;
					logger.addResult({
						kind: 'content',
						recipient,
						batchNumber,
						totalBatches,
						items: batch,
						status: 'error',
						error: error.message
					});
				}

				if (start + batchSize < items.length) {
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			}
		}
	}

	if (datasetItems.length > 0) {
		// /data/v1/ui/bulk/share takes a single recipient + accessLevel per call,
		// so group by (recipient, accessLevel).
		const datasetGroups = {};
		for (const item of datasetItems) {
			const key = `${item.recipient.type}:${item.recipient.id}|${item.accessLevel}`;
			if (!datasetGroups[key]) {
				datasetGroups[key] = { recipient: item.recipient, accessLevel: item.accessLevel, items: [] };
			}
			datasetGroups[key].items.push(item);
		}

		const batchSize = 50;
		const groupKeys = Object.keys(datasetGroups);

		console.log(
			`\nProcessing ${datasetItems.length} dataset(s) across ${groupKeys.length} recipient/access-level group(s) in batches of ${batchSize}...`
		);

		for (const key of groupKeys) {
			const { recipient, accessLevel, items } = datasetGroups[key];
			const totalBatches = Math.ceil(items.length / batchSize);

			console.log(
				`\n  ${recipient.type}=${recipient.id} @ ${accessLevel}: ${items.length} dataset(s)`
			);

			for (let start = 0; start < items.length; start += batchSize) {
				const batch = items.slice(start, start + batchSize);
				const batchNumber = Math.floor(start / batchSize) + 1;

				console.log(
					`  Processing dataset batch ${batchNumber}/${totalBatches} (${batch.length} items)...`
				);

				const body = {
					bulkItems: {
						ids: batch.map((item) => String(item.id)),
						type: 'DATA_SOURCE'
					},
					dataSourceShareEntity: {
						permissions: [
							{
								accessLevel,
								id: String(recipient.id),
								type: recipient.type.toUpperCase()
							}
						],
						sendEmail: false,
						message: 'Bulk sharing from script.'
					}
				};

				try {
					const result = await api.post('/data/v1/ui/bulk/share', body);
					const failed = (result && result.failed) || {};
					const failedIds = Object.keys(failed);
					const partialFailure = failedIds.length > 0;

					if (partialFailure) {
						console.error(
							`  Dataset batch ${batchNumber} partial failure: ${failedIds.length}/${batch.length} failed`
						);
						errorCount++;
						logger.addResult({
							kind: 'dataset',
							recipient,
							accessLevel,
							batchNumber,
							totalBatches,
							items: batch,
							status: 'partial-failure',
							failed,
							failedIds
						});
					} else {
						console.log(`  Dataset batch ${batchNumber} success (${batch.length} items)`);
						successCount++;
						if (verbose) {
							logger.addResult({
								kind: 'dataset',
								recipient,
								accessLevel,
								batchNumber,
								totalBatches,
								items: batch,
								status: 'success',
								response: result
							});
						}
					}
				} catch (error) {
					console.error(`  Dataset batch ${batchNumber} error:`, error.message);
					errorCount++;
					logger.addResult({
						kind: 'dataset',
						recipient,
						accessLevel,
						batchNumber,
						totalBatches,
						items: batch,
						status: 'error',
						error: error.message
					});
				}

				if (start + batchSize < items.length) {
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			}
		}
	}

	console.log('\n=== Summary ===');
	console.log(`Total items processed: ${fileJson.length}`);
	console.log(`  Content items: ${contentItems.length}`);
	console.log(`  Datasets: ${datasetItems.length}`);
	console.log(`Successful operations: ${successCount}`);
	console.log(`Failed operations: ${errorCount}`);

	logger.writeRunLog({
		totalItems: fileJson.length,
		contentItems: contentItems.length,
		datasetItems: datasetItems.length,
		successfulBatches: successCount,
		failedBatches: errorCount
	});

	if (errorCount > 0) {
		console.error('\nSome operations failed. Check the run log for details.');
		process.exit(1);
	} else {
		console.log('\nAll operations completed successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
