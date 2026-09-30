/**
 * Bulk update Domo users from a CSV via the PATCH /identity/v1/users/{id} endpoint.
 *
 * Each row is patched individually. Only columns included in the CSV will be
 * updated; empty cells are sent as null.
 *
 * The PATCH body is shaped as:
 *   { "attributes": [ { "key": "<column>", "values": ["<value>"] }, ... ] }
 *
 * --retry-errors [file] re-sends the logged attributes of a run's failed and
 * unreached users (default: the latest run log) without reading the CSV again.
 */

const { api, readCSV, showHelp, createLogger, loadSource, printSource, confirmSource, config } = require('../lib');
const argv = require('minimist')(process.argv.slice(2));

const COMMAND = 'bulk-update-users';
const SELECTION_FLAGS = ['file', 'f', 'id-column', 'filter-column', 'filter-value', 'dry-run', 'dry'];

const HELP_TEXT = `Usage: node cli.js bulk-update-users --file "users.csv" [options]

Bulk update Domo users from a CSV via PATCH /identity/v1/users/{id}.
Each row is patched individually. Only columns included in the CSV will be
updated; empty cells are sent as null.

CSV column headers must match the attribute keys Domo expects
(e.g. userName, displayName, emailAddress, phoneNumber, title, department,
employeeId, employeeNumber, employeeLocation, roleId, reportsTo, hireDate,
alternateEmail).

Options:
  --file, -f        CSV file with user rows (required)
  --id-column       CSV column containing the user ID (default: "id")
  --filter-column   CSV column to filter on (requires --filter-value)
  --filter-value    Value the filter-column must equal to include the row
  --dry-run         Preview changes without applying them
  --help, -h        Show this help message

Reusing an earlier run (re-sends the logged attributes; the CSV is not read):
  --retry-errors [file]  Retry the failed and unreached users of a run (default: the latest run log)
  --max-age <hours>      Allow a source log older than 24 hours
  --yes, -y              Skip the confirmation prompt`;

function workKey(item) {
	return `${item.userId}:${JSON.stringify(item.attributes)}`;
}

function loadWorkFromCsv() {
	const filePath = argv.file || argv.f;
	const idColumn = argv['id-column'] || 'id';

	if (!filePath) {
		console.error('Error: --file is required');
		console.error('Usage: node cli.js bulk-update-users --file "users.csv"');
		process.exit(1);
	}

	const filterColumn = argv['filter-column'] || null;
	const filterValue = argv['filter-value'] != null ? String(argv['filter-value']) : null;
	if (filterColumn && filterValue == null) {
		console.error('Error: --filter-column requires --filter-value');
		process.exit(1);
	}

	const records = readCSV(filePath, { filterColumn, filterValue });

	if (!Object.prototype.hasOwnProperty.call(records[0], idColumn)) {
		console.error(
			`Error: ID column "${idColumn}" not found in CSV. Available columns: ${Object.keys(records[0]).join(', ')}`
		);
		process.exit(1);
	}

	const updatableColumns = Object.keys(records[0]).filter((c) => c !== idColumn);
	if (updatableColumns.length === 0) {
		console.error(`Error: CSV has no columns to update beyond the ID column "${idColumn}"`);
		process.exit(1);
	}

	const work = records.map((record) => ({
		userId: String(record[idColumn] ?? '').trim(),
		attributes: buildAttributes(record, updatableColumns)
	}));
	return { work, updatableColumns, meta: { file: filePath, idColumn, filterColumn, filterValue } };
}

function buildAttributes(record, columns) {
	return columns.map((key) => {
		const raw = record[key];
		const trimmed = raw == null ? '' : String(raw).trim();
		const value = trimmed === '' ? null : trimmed;
		return { key, values: [value] };
	});
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const source = loadSource(COMMAND, argv, {
		selectionFlags: SELECTION_FLAGS,
		modes: ['retry-errors'],
		toEntries: (row) =>
			row.userId == null || !Array.isArray(row.attributes)
				? null
				: { userId: String(row.userId), attributes: row.attributes }
	});
	const dryRun = argv['dry-run'] || argv.dry || false;

	let work;
	let updatableColumns;
	let meta;
	if (source) {
		work = source.entries;
		updatableColumns = [...new Set(work.flatMap((item) => item.attributes.map((a) => a.key)))];
		meta = { file: source.meta.file, idColumn: source.meta.idColumn, filterColumn: source.meta.filterColumn, filterValue: source.meta.filterValue };
	} else {
		({ work, updatableColumns, meta } = loadWorkFromCsv());
	}
	const { idColumn } = meta;

	console.log('Bulk Update Users');
	console.log('=================\n');
	console.log(`Instance:         ${config.instanceUrl}`);
	console.log(`File:             ${meta.file}`);
	console.log(`ID column:        ${idColumn}`);
	console.log(`Patched fields:   ${updatableColumns.join(', ')}`);
	if (dryRun) console.log('DRY RUN (no changes will be made)');
	if (source) {
		console.log();
		printSource(source);
	}
	console.log(`Found ${work.length} user row(s) to process\n`);

	if (source) {
		if (work.length === 0) {
			console.log('The source log has nothing left to retry.');
			return;
		}
		const ok = await confirmSource(`Update ${work.length} user(s)? (yes/no): `, argv);
		if (!ok) {
			console.log('Aborted. No changes were made.');
			process.exit(0);
		}
		console.log();
	}

	const logger = createLogger(COMMAND, {
		debugMode: false,
		dryRun,
		source,
		runMeta: { ...meta, totalUsers: work.length }
	});
	logger.beginExecution(
		work.filter((item) => item.userId),
		workKey
	);

	let successCount = 0;
	let skipCount = 0;
	let errorCount = 0;

	for (let i = 0; i < work.length; i++) {
		const { userId, attributes } = work[i];
		const progress = `[${i + 1}/${work.length}]`;

		if (!userId) {
			console.warn(`${progress} Skipping row with empty "${idColumn}"`);
			logger.addResult({ userId: null, status: 'skipped', reason: 'empty id' });
			skipCount++;
			continue;
		}

		const fieldList = attributes
			.map((a) => {
				const v = a.values[0];
				return v === null ? `${a.key}=null` : `${a.key}="${v}"`;
			})
			.join(', ');
		console.log(`${progress} User ${userId}: ${fieldList}`);

		if (dryRun) {
			logger.addResult({ userId, status: 'dry-run', attributes });
			successCount++;
			continue;
		}

		try {
			await api.patch(`/identity/v1/users/${userId}`, { attributes });
			console.log(`  ✓ Updated`);
			logger.addResult({ userId, status: 'updated', attributes });
			successCount++;
		} catch (error) {
			console.error(`  ✗ Error: ${error.message}`);
			logger.addResult({ userId, status: 'error', attributes, error: error.message });
			errorCount++;
		}

		if (i < work.length - 1) {
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}

	console.log('\n=== Summary ===');
	console.log(`Total users:  ${work.length}`);
	console.log(`Updated:      ${successCount}`);
	console.log(`Skipped:      ${skipCount}`);
	console.log(`Errors:       ${errorCount}`);

	logger.writeRunLog({ successCount, skipCount, errorCount });

	if (errorCount > 0) {
		console.error(
			dryRun
				? '\nSome users failed to update. Check the error messages above.'
				: `\nSome users failed to update. Run "node cli.js ${COMMAND} --retry-errors" to retry them.`
		);
		process.exit(1);
	} else {
		console.log('\nAll users processed successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
