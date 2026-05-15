#!/usr/bin/env node

const commands = {
	'bulk-add-dataflow-tags': './commands/bulk-add-dataflow-tags',
	'bulk-add-dataflow-trigger-condition': './commands/bulk-add-dataflow-trigger-condition',
	'bulk-add-dataset-tags': './commands/bulk-add-dataset-tags',
	'bulk-apply-pdp-policies': './commands/bulk-apply-pdp-policies',
	'bulk-delete-dataflow-triggers': './commands/bulk-delete-dataflow-triggers',
	'bulk-delete-datasets': './commands/bulk-delete-datasets',
	'bulk-delete-users': './commands/bulk-delete-users',
	'bulk-rename-dataflows': './commands/bulk-rename-dataflows',
	'bulk-rename-datasets': './commands/bulk-rename-datasets',
	'bulk-convert-stream-provider': './commands/bulk-convert-stream-provider',
	'bulk-export-dataset-versions': './commands/bulk-export-dataset-versions',
	'bulk-list-user-content': './commands/bulk-list-user-content',
	'bulk-revoke-access-tokens': './commands/bulk-revoke-access-tokens',
	'bulk-unshare-content': './commands/bulk-unshare-content',
	'bulk-share-content': './commands/bulk-share-content',
	'bulk-transfer-ownership': './commands/bulk-transfer-ownership',
	'run-workflow-from-csv': './commands/run-workflow-from-csv',
	'bulk-update-column-pdp-policy': './commands/bulk-update-column-pdp-policy',
	'bulk-update-stream-schedules': './commands/bulk-update-stream-schedules',
	'bulk-update-stream-update-method': './commands/bulk-update-stream-update-method',
	'bulk-update-users': './commands/bulk-update-users',
	'extract-card-ids': './commands/extract-card-ids',
	'swap-input-in-dataflows': './commands/swap-input-in-dataflows',
	'transfer-stream': './commands/transfer-stream',
	'upload-dataset': './commands/upload-dataset'
};

// Strip --env <name> / --env=<name> from argv anywhere it appears, so it works
// before or after the command name. Set DOMO_ENV before any command (and thus
// lib/config.js) is loaded.
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a === '--env' && i + 1 < process.argv.length) {
		process.env.DOMO_ENV = process.argv[i + 1];
		process.argv.splice(i, 2);
		break;
	}
	if (a.startsWith('--env=')) {
		process.env.DOMO_ENV = a.slice('--env='.length);
		process.argv.splice(i, 1);
		break;
	}
}

const name = process.argv[2];

if (!name || name === '--help' || name === '-h' || name === 'help') {
	console.log('domo-scripts — CLI tools for managing Domo instances\n');
	console.log('Usage: node cli.js [--env <name>] <command> [options]\n');
	console.log('Global options:');
	console.log('  --env <name>    Load .env.<name> instead of (or in addition to) .env');
	console.log('');
	console.log('Commands:');
	for (const cmd of Object.keys(commands).sort()) {
		console.log(`  ${cmd}`);
	}
	console.log('\nRun "node cli.js <command> --help" for command-specific options.');
	process.exit(0);
}

if (!commands[name]) {
	console.error(`Unknown command: ${name}`);
	console.error(`Run "node cli.js --help" to see available commands.`);
	process.exit(1);
}

// Shift command name out of argv so commands see args starting at index 2
process.argv.splice(2, 1);

require(commands[name]);
