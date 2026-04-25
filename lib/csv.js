const fs = require('fs');
const { parse } = require('csv-parse/sync');

/**
 * Read and parse a CSV file, optionally filtering rows and extracting a column.
 *
 * @param {string} filePath     - Path to CSV file
 * @param {object} [options]
 * @param {string} [options.column]       - Column to extract values from
 * @param {string} [options.filterColumn] - Column to filter on
 * @param {string} [options.filterValue]  - Value the filterColumn must equal
 * @returns {string[]|object[]}  Array of column values (if column specified) or full records
 */
function readCSV(filePath, options = {}) {
	const { column, filterColumn, filterValue } = options;

	if (!fs.existsSync(filePath)) {
		throw new Error(`File not found: ${filePath}`);
	}

	const csvContent = fs.readFileSync(filePath, 'utf-8');
	const records = parse(csvContent, {
		bom: true,
		columns: true,
		skip_empty_lines: true,
		trim: true
	});

	if (records.length === 0) {
		throw new Error('CSV file is empty');
	}

	const columns = Object.keys(records[0]);

	if (column && !columns.includes(column)) {
		throw new Error(
			`Column "${column}" not found in CSV. Available columns: ${columns.join(', ')}`
		);
	}

	let filtered = records;

	if (filterColumn) {
		if (!columns.includes(filterColumn)) {
			throw new Error(
				`Filter column "${filterColumn}" not found in CSV. Available columns: ${columns.join(', ')}`
			);
		}
		filtered = records.filter((r) => r[filterColumn] === filterValue);
		console.log(
			`Filtered to ${filtered.length} of ${records.length} rows where "${filterColumn}" = "${filterValue}"`
		);
	}

	if (column) {
		return filtered.map((r) => r[column]).filter(Boolean);
	}

	return filtered;
}

module.exports = { readCSV };
