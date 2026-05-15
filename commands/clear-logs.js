/**
 * Delete every log file under logs/ (and remove the now-empty subdirectories)
 *
 * WARNING: This is a destructive operation. Cleared log files cannot be recovered.
 * Use --dry-run to preview what would be deleted before committing.
 *
 * Usage:
 *   node cli.js clear-logs
 *   node cli.js clear-logs --command bulkAddDataflowTriggerConditions
 *   node cli.js clear-logs --dry-run
 *
 * Options:
 *   --command, -c   Only clear logs for a specific command subdirectory
 *   --dry-run       Preview what would be deleted without removing files
 */

const fs = require('fs');
const path = require('path');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js clear-logs [options]

Delete every log file under logs/ (and remove the now-empty subdirectories).

Options:
  --command, -c   Only clear logs for a specific command subdirectory
  --dry-run       Preview what would be deleted without removing files`;

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const dryRun = argv['dry-run'] || false;
	const onlyCommand = argv.command || argv.c || null;

	const logsRoot = path.join(__dirname, '..', 'logs');

	console.log('Clear Logs');
	console.log('==========\n');
	if (dryRun) console.log('*** DRY RUN — no files will be deleted ***\n');
	console.log(`Logs root: ${logsRoot}`);
	if (onlyCommand) console.log(`Filter:    ${onlyCommand}`);
	console.log('');

	if (!fs.existsSync(logsRoot)) {
		console.log('No logs/ directory found — nothing to do.');
		return;
	}

	let subdirs = fs
		.readdirSync(logsRoot, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);

	if (onlyCommand) {
		if (!subdirs.includes(onlyCommand)) {
			console.log(`No logs/${onlyCommand}/ directory found — nothing to do.`);
			return;
		}
		subdirs = [onlyCommand];
	}

	if (subdirs.length === 0) {
		console.log('No log subdirectories found — nothing to do.');
		return;
	}

	console.log(`Found ${subdirs.length} subdirectory(ies) to process\n`);

	let totalFiles = 0;
	let totalBytes = 0;
	let dirsRemoved = 0;
	let errorCount = 0;

	for (let i = 0; i < subdirs.length; i++) {
		const sub = subdirs[i];
		const dir = path.join(logsRoot, sub);
		console.log(`[${i + 1}/${subdirs.length}] ${sub}`);

		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			console.error(`  ✗ Could not read directory: ${err.message}`);
			errorCount++;
			continue;
		}

		let dirFiles = 0;
		let dirBytes = 0;

		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const fp = path.join(dir, entry.name);
			let size = 0;
			try {
				size = fs.statSync(fp).size;
			} catch (_) {}

			if (dryRun) {
				console.log(`  [DRY RUN] Would delete ${entry.name} (${formatBytes(size)})`);
				dirFiles++;
				dirBytes += size;
			} else {
				try {
					fs.unlinkSync(fp);
					console.log(`  ✓ Deleted ${entry.name}`);
					dirFiles++;
					dirBytes += size;
				} catch (err) {
					console.error(`  ✗ Failed to delete ${entry.name}: ${err.message}`);
					errorCount++;
				}
			}
		}

		if (dirFiles === 0) {
			console.log(`  (empty — nothing to delete)`);
		}

		if (dryRun && dirFiles > 0) {
			console.log(`  [DRY RUN] Would remove empty directory`);
			dirsRemoved++;
		} else if (!dryRun) {
			try {
				const remaining = fs.readdirSync(dir);
				if (remaining.length === 0) {
					fs.rmdirSync(dir);
					console.log(`  ✓ Removed empty directory`);
					dirsRemoved++;
				}
			} catch (err) {
				console.error(`  ✗ Could not remove directory: ${err.message}`);
				errorCount++;
			}
		}

		console.log(`  ${dirFiles} file(s), ${formatBytes(dirBytes)}\n`);
		totalFiles += dirFiles;
		totalBytes += dirBytes;
	}

	console.log('=== Summary ===');
	console.log(`Subdirectories scanned: ${subdirs.length}`);
	console.log(`Files ${dryRun ? 'to delete' : 'deleted'}:      ${totalFiles}`);
	console.log(`Total size:             ${formatBytes(totalBytes)}`);
	console.log(`Dirs ${dryRun ? 'to remove' : 'removed'}:       ${dirsRemoved}`);
	console.log(`Errors:                 ${errorCount}`);

	if (dryRun && totalFiles > 0) {
		console.log('\nRe-run without --dry-run to execute the deletion.');
	}

	if (errorCount > 0) {
		console.error('\nSome items failed. Check the error messages above.');
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
