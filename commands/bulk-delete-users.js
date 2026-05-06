/**
 * Bulk delete Domo users.
 *
 * WARNING: This command does NOT check or transfer ownership of users' content
 * before deleting them. Any datasets, cards, pages, dataflows, etc. they own
 * will be orphaned. Run bulk-transfer-ownership first if you want to preserve
 * their content.
 *
 * Usage:
 *   node cli.js bulk-delete-users --user-id 12345
 *   node cli.js bulk-delete-users --user-ids 12345,67890
 *   node cli.js bulk-delete-users --file users.csv [--column "User ID"]
 *   node cli.js bulk-delete-users --file users.csv --dry-run
 *   node cli.js bulk-delete-users --file users.csv --yes      # non-interactive
 */

const argv = require('minimist')(process.argv.slice(2));
const { api, resolveIds, createLogger, showHelp } = require('../lib');

const HELP_TEXT = `Usage: node cli.js bulk-delete-users [options]

WARNING: This command does NOT check or transfer ownership of users' content.
After deletion, any datasets, cards, pages, dataflows, etc. they own will be
orphaned. Run bulk-transfer-ownership first if you want to preserve content.

ID source (one of):
  --user-id <id>        Single user ID (enables debug logging)
  --user-ids <a,b,c>    Comma-separated user IDs
  --file <path>         CSV with user IDs (default column: "User ID")

Optional:
  --column <name>       CSV column with user IDs (default: "User ID")
  --filter-column <c>   Filter input CSV rows by column
  --filter-value <v>    Required value for --filter-column
  --dry-run             Print who would be deleted; skip prompt and DELETE
  --yes                 Skip the interactive confirmation prompt. Required for
                        non-TTY runs (CI, piped stdin)
  --help                Show this help`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function promptConfirm() {
	const readline = require('readline/promises');
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question('\nType DELETE to confirm: ');
		return answer.trim() === 'DELETE';
	} finally {
		rl.close();
	}
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const dryRun = Boolean(argv['dry-run']);
	const skipPrompt = Boolean(argv.yes);

	const { ids: userIds, debugMode } = resolveIds(argv, {
		name: 'user',
		columnDefault: 'User ID'
	});

	console.log('Bulk Delete Users');
	console.log('=================');
	console.log(`Users:   ${userIds.length}`);
	if (dryRun) console.log('Dry run: yes (no DELETE will be issued)');
	console.log();

	console.log(`About to DELETE ${userIds.length} user(s):`);
	for (const id of userIds) console.log(`  ${id}`);
	console.log();
	console.log('⚠  This command does NOT check or transfer ownership of these users\' content.');
	console.log('   After deletion, any datasets, cards, pages, dataflows, etc. they own will');
	console.log('   be orphaned and require manual cleanup.');
	console.log();
	console.log('   Run bulk-transfer-ownership FIRST if you want to preserve their content.');

	if (dryRun) {
		console.log('\nDry run — exiting without prompting or deleting.');
		const logger = createLogger('bulk-delete-users', { debugMode, dryRun });
		for (const id of userIds) logger.addResult({ userId: id, status: 'dry-run' });
		logger.writeRunLog({ total: userIds.length, deleted: 0, errors: 0 });
		return;
	}

	if (!skipPrompt) {
		if (!process.stdin.isTTY) {
			console.error('\nError: stdin is not a TTY. Pass --yes to confirm non-interactively.');
			process.exit(1);
		}
		const ok = await promptConfirm();
		if (!ok) {
			console.log('Aborted. No users were deleted.');
			process.exit(1);
		}
	}

	const logger = createLogger('bulk-delete-users', { debugMode, dryRun });
	let deleted = 0;
	let errors = 0;

	for (let i = 0; i < userIds.length; i++) {
		const id = userIds[i];
		console.log(`[${i + 1}/${userIds.length}] DELETE user ${id}`);
		try {
			await api.del(`/identity/v1/users/${id}`);
			console.log('  ✓ deleted');
			logger.addResult({ userId: id, status: 'deleted' });
			if (debugMode) logger.writeDebugLog(id, { userId: id, status: 'deleted' });
			deleted++;
		} catch (err) {
			console.error(`  ✗ ${err.message}`);
			logger.addResult({ userId: id, status: 'error', error: err.message });
			if (debugMode) logger.writeDebugLog(id, { userId: id, error: err.message });
			errors++;
		}
		if (i < userIds.length - 1) await delay(200);
	}

	console.log('\n=== Summary ===');
	console.log(`Total:   ${userIds.length}`);
	console.log(`Deleted: ${deleted}`);
	console.log(`Errors:  ${errors}`);

	logger.writeRunLog({ total: userIds.length, deleted, errors });
	if (errors > 0) process.exit(1);
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
