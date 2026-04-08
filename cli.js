#!/usr/bin/env node

const commands = {
	'bulk-add-dataflow-tags': './commands/bulk-add-dataflow-tags',
	'bulk-add-dataflow-trigger-condition': './commands/bulk-add-dataflow-trigger-condition',
	'bulk-add-dataset-tags': './commands/bulk-add-dataset-tags',
	'bulk-apply-pdp-policies': './commands/bulk-apply-pdp-policies',
	'bulk-delete-datasets': './commands/bulk-delete-datasets',
	'bulk-rename-dataflows': './commands/bulk-rename-dataflows',
	'bulk-rename-datasets': './commands/bulk-rename-datasets',
	'bulk-convert-stream-provider': './commands/bulk-convert-stream-provider',
	'bulk-export-dataset-versions': './commands/bulk-export-dataset-versions',
	'bulk-revoke-content': './commands/bulk-revoke-content',
	'bulk-share-content': './commands/bulk-share-content',
	'bulk-update-column-pdp-policy': './commands/bulk-update-column-pdp-policy',
	'bulk-update-stream-schedules': './commands/bulk-update-stream-schedules',
	'bulk-update-stream-update-method': './commands/bulk-update-stream-update-method',
	'extract-card-ids': './commands/extract-card-ids',
	'swap-input-in-dataflows': './commands/swap-input-in-dataflows',
	'upload-dataset': './commands/upload-dataset'
};

const name = process.argv[2];

if (!name || name === '--help' || name === '-h' || name === 'help') {
	console.log('domo-scripts — CLI tools for managing Domo instances\n');
	console.log('Usage: node cli.js <command> [options]\n');
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
