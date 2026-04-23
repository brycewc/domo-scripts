/**
 * Bulk update Domo users from a CSV via the PATCH /identity/v1/users/{id} endpoint.
 *
 * Each row is patched individually. Only columns included in the CSV will be
 * updated; empty cells are sent as null.
 *
 * The PATCH body is shaped as:
 *   { "attributes": [ { "key": "<column>", "values": ["<value>"] }, ... ] }
 */

const api = require('../lib/api');
const { readCSV } = require('../lib/csv');
const { showHelp } = require('../lib/help');
const { createLogger } = require('../lib/log');
const { instanceUrl } = require('../lib/config');
const argv = require('minimist')(process.argv.slice(2));

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
  --help, -h        Show this help message`;

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

	const filePath = argv.file || argv.f;
	const idColumn = argv['id-column'] || 'id';
	const dryRun = argv['dry-run'] || argv.dry || false;

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

	console.log('Bulk Update Users');
	console.log('=================\n');
	console.log(`Instance:         ${instanceUrl}`);
	console.log(`File:             ${filePath}`);
	console.log(`ID column:        ${idColumn}`);
	console.log(`Patched fields:   ${updatableColumns.join(', ')}`);
	if (dryRun) console.log('DRY RUN (no changes will be made)');
	console.log(`Found ${records.length} user row(s) to process\n`);

	const logger = createLogger('updateUsers', {
		debugMode: false,
		dryRun,
		runMeta: {
			file: filePath,
			idColumn,
			filterColumn,
			filterValue,
			totalUsers: records.length
		}
	});

	let successCount = 0;
	let skipCount = 0;
	let errorCount = 0;

	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		const userId = String(record[idColumn] ?? '').trim();
		const progress = `[${i + 1}/${records.length}]`;

		if (!userId) {
			console.warn(`${progress} Skipping row with empty "${idColumn}"`);
			logger.addResult({ userId: null, status: 'skipped', reason: 'empty id' });
			skipCount++;
			continue;
		}

		const attributes = buildAttributes(record, updatableColumns);
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

		if (i < records.length - 1) {
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}

	console.log('\n=== Summary ===');
	console.log(`Total users:  ${records.length}`);
	console.log(`Updated:      ${successCount}`);
	console.log(`Skipped:      ${skipCount}`);
	console.log(`Errors:       ${errorCount}`);

	logger.writeRunLog({ successCount, skipCount, errorCount });

	if (errorCount > 0) {
		console.error('\nSome users failed to update. Check the error messages above.');
		process.exit(1);
	} else {
		console.log('\nAll users processed successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
