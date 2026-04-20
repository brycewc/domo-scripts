/**
 * Convert a CSV file to workflow input format and run a Domo workflow.
 *
 * Each CSV column becomes an array in the workflow body keyed by the column
 * header name. Columns listed in --numeric-columns are parsed as integers;
 * all others are kept as strings.
 *
 * Usage:
 *   node cli.js run-workflow-from-csv --workflow-id "<id>" --file "/path/to/data.csv"
 *   node cli.js run-workflow-from-csv --workflow-id "<id>" --file "/path/to/data.csv" --numeric-columns "hireDate,salary"
 */

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage:
  node cli.js run-workflow-from-csv --workflow-id "<id>" --file "/path/to/data.csv"
  node cli.js run-workflow-from-csv --workflow-id "<id>" --file "/path/to/data.csv" --numeric-columns "hireDate,salary"

Options:
  --workflow-id, -w       Workflow model ID (required)
  --file, -f              Path to the CSV file (required)
  --numeric-columns, -n   Comma-separated column names to parse as integers
  --help, -h              Show this help message`;

showHelp(argv, HELP_TEXT);

const { api } = require('../lib');

function csvToWorkflowBody(csvPath, numericColumns) {
	const raw = fs.readFileSync(csvPath, 'utf8');
	const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });

	if (records.length === 0) {
		throw new Error('CSV file contains no data rows');
	}

	const columnHeaders = Object.keys(records[0]);
	const out = {};
	columnHeaders.forEach((h) => (out[h] = []));

	for (const row of records) {
		columnHeaders.forEach((h) => {
			const val = row[h] ?? '';
			if (numericColumns.has(h)) {
				out[h].push(parseInt(val, 10) || 0);
			} else {
				out[h].push(String(val));
			}
		});
	}

	return out;
}

async function main() {
	const workflowId = argv['workflow-id'] || argv.w;
	const csvPath = argv.file || argv.f;
	const numericColumnsArg = argv['numeric-columns'] || argv.n || '';
	const numericColumns = new Set(
		String(numericColumnsArg).split(',').map((s) => s.trim()).filter(Boolean)
	);

	if (!workflowId || !csvPath) {
		console.error('Error: --workflow-id and --file are required');
		console.error('\nUsage:');
		console.error(
			'  node cli.js run-workflow-from-csv --workflow-id "<id>" --file "/path/to/data.csv"'
		);
		process.exit(1);
	}

	if (!fs.existsSync(csvPath)) {
		console.error(`Error: file not found: ${csvPath}`);
		process.exit(1);
	}

	console.log('Converting CSV to workflow body...');
	const body = csvToWorkflowBody(csvPath, numericColumns);
	const columnNames = Object.keys(body);
	console.log(`  Columns: ${columnNames.join(', ')}`);
	console.log(`  Rows: ${body[columnNames[0]].length}`);

	console.log('Fetching workflow model...');
	const model = await api.get(`/workflow/v1/models/${workflowId}`);
	const versions = model.versions;
	if (!Array.isArray(versions) || versions.length === 0) {
		throw new Error('Workflow model has no versions');
	}

	const deployedVersions = versions.filter((v) => v.deployedOn != null);
	if (deployedVersions.length === 0) {
		throw new Error('Workflow model has no deployed versions');
	}

	const latest = deployedVersions.reduce((a, b) =>
		(Number(a.version) || 0) > (Number(b.version) || 0) ? a : b
	);
	const manualTriggerId = latest.manualTriggerId;
	if (!manualTriggerId) {
		throw new Error(
			`Latest deployed version (${latest.version}) has no manualTriggerId`
		);
	}

	console.log(
		`Activating workflow (version ${latest.version}, trigger ${manualTriggerId})...`
	);
	const result = await api.post(
		`/workflow/v2/triggers/${manualTriggerId}/activate`,
		body
	);
	console.log('Workflow run triggered successfully.');
	if (result && typeof result === 'object') {
		console.log(JSON.stringify(result, null, 2));
	}
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});
