/**
 * Bulk delete Domo accounts (data connection accounts) from a CSV file or ID list
 *
 * WARNING: This is a destructive operation. Deleted accounts cannot be recovered.
 * Any streams/datasets that rely on a deleted account will stop updating until
 * they are pointed at a different account. Use --dry-run to preview which
 * accounts would be deleted before committing.
 *
 * There is no bulk-delete API for accounts, so each account is deleted with an
 * individual DELETE call.
 *
 * Usage:
 *   node cli.js bulk-delete-accounts --file "accounts.csv"
 *   node cli.js bulk-delete-accounts --file "accounts.csv" --column "My Column"
 *   node cli.js bulk-delete-accounts --file "accounts.csv" --dry-run
 *   node cli.js bulk-delete-accounts --account-id "12345"
 *   node cli.js bulk-delete-accounts --account-ids "id1,id2,id3"
 *
 * Options:
 *   --file, -f     CSV file with account IDs
 *   --account-id   Single account ID (enables debug logging)
 *   --account-ids  Comma-separated account IDs
 *   --column, -c   CSV column name containing account IDs (default: "Account ID")
 *   --dry-run      Preview which accounts would be deleted without actually deleting
 */

const { api, resolveIds, createLogger, showHelp } = require('../lib');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-delete-accounts [options]

WARNING: This is a destructive operation.

Options:
  --file, -f     CSV file with account IDs
  --account-id   Single account ID
  --account-ids  Comma-separated account IDs
  --column, -c   CSV column with account IDs (default: "Account ID")
  --dry-run      Preview without deleting`;

async function deleteAccount(id) {
	return api.del(`/accounts/v1/accounts/${id}`);
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const dryRun = argv['dry-run'] || argv.dry || false;

	const { ids: accountIds, debugMode } = resolveIds(argv, {
		name: 'account',
		columnDefault: 'Account ID'
	});

	const logger = createLogger('bulk-delete-accounts', { debugMode, dryRun });

	console.log('Bulk Delete Accounts');
	console.log('====================\n');
	if (dryRun) {
		console.log('*** DRY RUN — no accounts will be deleted ***\n');
	}
	console.log(`Accounts: ${accountIds.length}`);
	console.log('\nNote: streams/datasets relying on a deleted account will stop updating.\n');

	if (dryRun) {
		for (const id of accountIds) {
			console.log(`Would delete account ${id}`);
			logger.addResult({ accountId: id, status: 'dry-run' });
		}

		console.log('\n=== Dry Run Summary ===');
		console.log(`Total accounts that would be deleted: ${accountIds.length}`);
		console.log('\nRe-run without --dry-run to execute the deletion.');
		logger.writeRunLog({ total: accountIds.length, deleted: 0, errors: 0 });
		process.exit(0);
	}

	let successCount = 0;
	let errorCount = 0;

	for (let i = 0; i < accountIds.length; i++) {
		const id = accountIds[i];
		console.log(`[${i + 1}/${accountIds.length}] Deleting account ${id}...`);

		try {
			await deleteAccount(id);
			console.log('  ✓ deleted');
			logger.addResult({ accountId: id, status: 'deleted' });
			if (debugMode) logger.writeDebugLog(id, { accountId: id, status: 'deleted' });
			successCount++;
		} catch (error) {
			console.error(`  ✗ ${error.message}`);
			logger.addResult({ accountId: id, status: 'error', error: error.message });
			if (debugMode) logger.writeDebugLog(id, { accountId: id, status: 'error', error: error.message });
			errorCount++;
		}

		if (i < accountIds.length - 1) {
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}

	console.log('\n=== Summary ===');
	console.log(`Total accounts: ${accountIds.length}`);
	console.log(`Successfully deleted: ${successCount}`);
	console.log(`Errors: ${errorCount}`);

	logger.writeRunLog({ total: accountIds.length, deleted: successCount, errors: errorCount });

	if (errorCount > 0) {
		console.error('\nSome accounts failed. Check the error messages above.');
		process.exit(1);
	} else {
		console.log('\nAll accounts deleted successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
