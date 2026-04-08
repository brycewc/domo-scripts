/**
 * Extract cardId values from a cards JSON file and create a simple array of integers
 *
 * Usage:
 *   node cli.js extract-card-ids --input "/path/to/all-users-cards.json" --output "/path/to/output.json"
 *
 * Options:
 *   --input   Path to the input JSON file (required)
 *   --output  Path to the output JSON file (default: <input-dir>/<input-name>-ids-only.json)
 */

const fs = require('fs');
const path = require('path');
const argv = require('minimist')(process.argv.slice(2));

const inputFile = argv.input || argv._[0];
if (!inputFile) {
	console.error('Error: --input is required');
	console.error('\nUsage:');
	console.error(
		'  node cli.js extract-card-ids --input "/path/to/all-users-cards.json"'
	);
	process.exit(1);
}

const defaultOutput = path.join(
	path.dirname(inputFile),
	path.basename(inputFile, path.extname(inputFile)) + '-ids-only.json'
);
const outputFile = argv.output || defaultOutput;

try {
	console.log('Reading input file...');
	const data = fs.readFileSync(inputFile, 'utf8');
	const json = JSON.parse(data);

	console.log('Extracting card IDs...');
	const cardIds = json.cardAdminSummaries.map((card) => card.cardId);

	console.log(`Found ${cardIds.length} card IDs`);

	console.log('Writing output file...');
	fs.writeFileSync(outputFile, JSON.stringify(cardIds, null, 2), 'utf8');

	console.log(`Successfully created ${outputFile}`);
	console.log(`First 10 card IDs: ${cardIds.slice(0, 10).join(', ')}`);
} catch (error) {
	console.error('Error:', error.message);
	process.exit(1);
}
