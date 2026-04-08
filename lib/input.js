const { readCSV } = require('./csv');

/**
 * Resolve a list of IDs from CLI args: --file (CSV), --<name>-id (single), or --<name>-ids (comma-separated).
 *
 * @param {object} argv            - Parsed minimist args
 * @param {object} options
 * @param {string} options.name    - Entity name, e.g. "stream" → looks for --stream-id, --stream-ids
 * @param {string} [options.columnDefault] - Default CSV column name (default: "<name>Id")
 * @returns {{ ids: string[], debugMode: boolean }}
 */
function resolveIds(argv, options) {
	const { name, columnDefault } = options;
	const idFlag = `${name}-id`;
	const idsFlag = `${name}-ids`;
	const column = argv.column || argv.c || columnDefault || `${name}Id`;

	if (argv[idFlag]) {
		return { ids: [String(argv[idFlag])], debugMode: true };
	}

	if (argv[idsFlag]) {
		const ids = String(argv[idsFlag])
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean);
		if (ids.length === 0) {
			throw new Error(`No IDs provided in --${idsFlag}`);
		}
		return { ids, debugMode: false };
	}

	const filePath = argv.file || argv.f;
	if (!filePath) {
		throw new Error(`One of --file, --${idFlag}, or --${idsFlag} is required`);
	}

	const filterColumn = argv['filter-column'] || null;
	const filterValue = argv['filter-value'] != null ? String(argv['filter-value']) : null;

	if (filterColumn && filterValue == null) {
		throw new Error('--filter-column requires --filter-value');
	}

	const ids = readCSV(filePath, { column, filterColumn, filterValue });

	if (ids.length === 0) {
		throw new Error('No IDs found in CSV');
	}

	return { ids, debugMode: false };
}

module.exports = { resolveIds };
