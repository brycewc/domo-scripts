const fs = require('fs');
const path = require('path');
const readline = require('readline');
const config = require('./config');
const { LOGS_DIR, PLAN_VERSION } = require('./log');

const DEFAULT_MAX_AGE_HOURS = 24;
const HEADER_SCAN_BYTES = 65536;
const MODES = {
	'from-dry-run': { prefix: 'dry_run', dryRun: true, backref: 'fromPlan', label: 'dry run' },
	'retry-errors': { prefix: 'run', dryRun: false, backref: 'retryOf', label: 'run' }
};

class SourceError extends Error {}

function stripStatus(row) {
	const { status, error, phase, batch, retried, reason, ...entry } = row;
	return entry;
}

function fail(message) {
	throw new SourceError(message);
}

function flagName(name, value) {
	if (name.length === 1) return `-${name}`;
	return value === false ? `--no-${name}` : `--${name}`;
}

function listLogs(dir, prefix) {
	if (!fs.existsSync(dir)) return [];
	const pattern = new RegExp(`^${prefix}_(\\d+)\\.json$`);
	return fs
		.readdirSync(dir)
		.map((name) => ({ name, match: pattern.exec(name) }))
		.filter((f) => f.match)
		.sort((a, b) => Number(b.match[1]) - Number(a.match[1]))
		.map((f) => path.join(dir, f.name));
}

function resolveLogPath(commandName, ref, mode) {
	const { prefix, label } = MODES[mode];
	if (ref === true || ref === 'latest') {
		const [latest] = listLogs(path.join(LOGS_DIR, commandName), prefix);
		if (!latest) fail(`No ${label} logs found in logs/${commandName}/.`);
		return latest;
	}
	const file = path.resolve(String(ref));
	if (!fs.existsSync(file)) fail(`${file} does not exist.`);
	return file;
}

// Header fields are serialized before `results`, so the first few KB are enough
// to read them without parsing a large log.
function readHeaderField(file, field) {
	const fd = fs.openSync(file, 'r');
	try {
		const buf = Buffer.alloc(HEADER_SCAN_BYTES);
		const bytes = fs.readSync(fd, buf, 0, HEADER_SCAN_BYTES, 0);
		const match = new RegExp(`"${field}":\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(buf.toString('utf8', 0, bytes));
		return match ? JSON.parse(match[1]) : null;
	} finally {
		fs.closeSync(fd);
	}
}

function findLaterUses(file, mode) {
	const { backref } = MODES[mode];
	return listLogs(path.dirname(file), 'run')
		.filter((other) => other !== file)
		.filter((other) => {
			const ref = readHeaderField(other, backref);
			return ref && path.resolve(ref) === file;
		})
		.map((other) => path.relative(process.cwd(), other));
}

function checkInstance(log, instances) {
	if (instances) {
		for (const side of ['source', 'target']) {
			const recorded = log.instances && log.instances[side] && log.instances[side].instance;
			const current = instances[side] && instances[side].instance;
			if (recorded !== current) {
				fail(`The log's ${side} instance is "${recorded}", but this run's ${side} instance is "${current}".`);
			}
		}
		return;
	}
	if (log.instance !== config.instance) {
		fail(
			`The log was recorded against instance "${log.instance}", but the current instance is "${config.instance}". Pass --env to select the matching instance.`
		);
	}
}

function parseMaxAge(argv) {
	if (argv['max-age'] === undefined) return DEFAULT_MAX_AGE_HOURS;
	const hours = Number(argv['max-age']);
	if (!Number.isFinite(hours) || hours <= 0) fail(`--max-age must be a positive number of hours, got "${argv['max-age']}".`);
	return hours;
}

function toEntryList(rows, toEntries) {
	const entries = [];
	let dropped = 0;
	for (const row of rows) {
		const mapped = toEntries(row);
		if (mapped == null) dropped++;
		else if (Array.isArray(mapped)) entries.push(...mapped);
		else entries.push(mapped);
	}
	return { entries, dropped };
}

/**
 * Load the entries a --from-dry-run or --retry-errors run acts on, or null when neither flag is set.
 *
 * @param {object} [options]
 * @param {string[]} [options.selectionFlags] - Flags the log's recorded options replace; passing one is an error
 * @param {string[]} [options.modes] - Which of 'from-dry-run' / 'retry-errors' the command supports
 * @param {(row: object) => object|object[]|null} [options.toEntries] - Log row to execute entries; null drops it
 * @param {object} [options.instances] - { source, target } for two-instance commands
 */
function loadSource(commandName, argv, options = {}) {
	const { selectionFlags = [], modes = Object.keys(MODES), toEntries = stripStatus, instances } = options;
	try {
		const requested = Object.keys(MODES).filter((m) => argv[m] !== undefined && argv[m] !== false);
		if (requested.length === 0) return null;
		if (requested.length > 1) fail('--from-dry-run and --retry-errors cannot be used together.');
		const mode = requested[0];
		if (!modes.includes(mode)) fail(`${commandName} does not support --${mode}.`);

		// minimist parses --no-x as x: false, so false still counts as passed.
		const conflicts = selectionFlags.filter((f) => argv[f] !== undefined);
		if (conflicts.length > 0) {
			fail(
				`--${mode} reuses the options recorded in the log, so it cannot be combined with ${conflicts.map((f) => flagName(f, argv[f])).join(', ')}.`
			);
		}

		const file = resolveLogPath(commandName, argv[mode], mode);
		let log;
		try {
			log = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch (err) {
			fail(`Could not read ${file}: ${err.message}`);
		}

		const { dryRun, label } = MODES[mode];
		if (log.dryRun !== dryRun) {
			fail(
				dryRun
					? `${file} is a real run log. Use --retry-errors to retry it.`
					: `${file} is a dry run log. Use --from-dry-run to run its plan.`
			);
		}
		const recordedCommand = log.command || path.basename(path.dirname(file));
		if (recordedCommand !== commandName) fail(`${file} was written by ${recordedCommand}, not ${commandName}.`);
		if (log.planVersion > PLAN_VERSION) fail(`${file} was written by a newer version of domo-scripts.`);
		checkInstance(log, instances);

		const maxAge = parseMaxAge(argv);
		const ageHours = (Date.now() - Date.parse(log.timestamp)) / 3600000;
		if (!(ageHours <= maxAge)) {
			fail(
				`The ${label} log is ${ageHours.toFixed(1)} hours old (limit ${maxAge}). Pass --max-age <hours> to use it anyway.`
			);
		}

		const results = log.results || [];
		let planned;
		let unreachedList = { entries: [], dropped: 0 };
		let discoveryErrors = [];
		if (mode === 'from-dry-run') {
			planned = toEntryList(
				results.filter((r) => r.status === 'dry-run'),
				toEntries
			);
		} else {
			const errors = results.filter((r) => r.status === 'error');
			discoveryErrors = errors.filter((r) => r.phase === 'discover');
			planned = toEntryList(
				errors.filter((r) => r.phase !== 'discover'),
				toEntries
			);
			unreachedList = toEntryList(log.unreached || [], toEntries);
		}

		const { results: _results, unreached: _unreached, summary, ...meta } = log;
		return {
			mode,
			path: file,
			relPath: path.relative(process.cwd(), file),
			meta,
			summary: summary || {},
			entries: planned.entries.concat(unreachedList.entries),
			dropped: planned.dropped + unreachedList.dropped,
			discoveryErrors,
			unreachedCount: unreachedList.entries.length,
			ageHours,
			laterUses: findLaterUses(file, mode)
		};
	} catch (err) {
		if (!(err instanceof SourceError)) throw err;
		console.error(`Error: ${err.message}`);
		process.exit(1);
	}
}

function printSource(source) {
	const { label } = MODES[source.mode];
	console.log(`Source:         ${source.relPath}`);
	console.log(`                ${label} from ${source.meta.timestamp} (${source.ageHours.toFixed(1)} hours ago)`);
	if (source.mode === 'retry-errors') {
		const errorCount = source.entries.length - source.unreachedCount;
		console.log(`Retrying:       ${errorCount} failed + ${source.unreachedCount} unreached item(s)`);
		if (source.summary.incomplete) console.log('                (the source run stopped before finishing)');
	} else {
		console.log(`Planned:        ${source.entries.length} item(s)`);
	}
	if (source.dropped > 0) {
		console.log(`Dropped:        ${source.dropped} log row(s) without the fields needed to act on them`);
	}
	if (source.discoveryErrors.length > 0) {
		console.log(
			`Not retried:    ${source.discoveryErrors.length} item(s) that failed before any change was attempted (see the source log)`
		);
	}
	for (const use of source.laterUses) {
		console.log(`WARNING: ${use} already used this log.`);
	}
	console.log();
}

// --yes / -y skips the prompt. Closed stdin counts as "no".
function confirmSource(question, argv) {
	if (argv.yes || argv.y) return Promise.resolve(true);
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		let answered = false;
		rl.on('close', () => {
			if (!answered) resolve(false);
		});
		rl.question(question, (answer) => {
			answered = true;
			rl.close();
			const normalized = answer.trim().toLowerCase();
			resolve(normalized === 'yes' || normalized === 'y');
		});
	});
}

module.exports = { loadSource, printSource, confirmSource, stripStatus };
