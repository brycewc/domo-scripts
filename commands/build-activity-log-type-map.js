/**
 * Build a map of activity-log object types to their available event types (actions).
 *
 * Calls /audit/v1/user-audits/objectTypes to get the list of object types, then for
 * each object type calls /audit/v1/user-audits/objectTypes/{type}/eventTypes and
 * attaches the result as a new `actions` property on that object type. The full,
 * enriched array is written to activity-log-type-map-<YYYY-MM-DD>.json.
 *
 * Usage:
 *   node cli.js build-activity-log-type-map
 *   node cli.js build-activity-log-type-map --out "./out"
 *
 * Options:
 *   --out, -o   Directory to write the JSON file to
 *               (default: logs/activityLogTypeMap/)
 */

const fs = require('fs');
const path = require('path');
const api = require('../lib/api');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

// Sort an array of { type, ... } objects alphabetically by their type field.
function sortByType(items) {
	return items.sort((a, b) => String(a.type).localeCompare(String(b.type)));
}

const HELP_TEXT = `Usage:
  node cli.js build-activity-log-type-map
  node cli.js build-activity-log-type-map --out "./out"

Options:
  --out, -o   Directory to write the JSON file to
              (default: logs/buildActivityLogTypeMap/)`;

// Default output lives under the project's logs/ dir, in a per-command subfolder,
// matching the convention used by createLogger.
const DEFAULT_OUT_DIR = path.join(process.cwd(), 'logs', 'buildActivityLogTypeMap');

async function main() {
	showHelp(argv, HELP_TEXT);

	const outDir = argv.out || argv.o || DEFAULT_OUT_DIR;

	console.log('Fetching object types...');
	const objectTypes = await api.get('/audit/v1/user-audits/objectTypes');

	if (!Array.isArray(objectTypes)) {
		throw new Error('Expected an array of object types from /audit/v1/user-audits/objectTypes');
	}

	console.log(`Found ${objectTypes.length} object type(s)\n`);

	for (let i = 0; i < objectTypes.length; i++) {
		const objectType = objectTypes[i];
		const { type } = objectType;
		const progress = `[${i + 1}/${objectTypes.length}]`;

		console.log(`${progress} Fetching event types for "${type}"...`);
		const actions = await api.get(`/audit/v1/user-audits/objectTypes/${encodeURIComponent(type)}/eventTypes`);
		objectType.actions = Array.isArray(actions) ? sortByType(actions) : actions;

		if (i < objectTypes.length - 1) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	sortByType(objectTypes);

	const isoDate = new Date().toISOString().slice(0, 10);
	const fileName = `activity-log-type-map-${isoDate}.json`;
	const outPath = path.resolve(outDir, fileName);

	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, JSON.stringify(objectTypes, null, 2));

	console.log(`\nWrote ${objectTypes.length} object type(s) to ${outPath}`);
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});
