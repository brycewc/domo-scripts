const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');

/**
 * Create a logger for a specific command. Handles both per-item debug logs
 * (single-ID mode) and summary run logs (bulk mode).
 *
 * @param {string} commandName - Used as the subdirectory under logs/
 * @param {object} options
 * @param {boolean} options.debugMode - If true, writes per-item debug logs
 * @param {boolean} options.dryRun    - If true, prefixes log filenames with "dry_"
 * @param {object}  [options.runMeta] - Extra metadata to include in the run log header
 */
function createLogger(commandName, options = {}) {
	const { debugMode = false, dryRun = false, runMeta = {} } = options;
	const logDir = path.join(LOGS_DIR, commandName);

	const runLog = debugMode
		? null
		: {
				timestamp: new Date().toISOString(),
				...runMeta,
				dryRun,
				results: []
			};

	function ensureDir() {
		fs.mkdirSync(logDir, { recursive: true });
	}

	function writeDebugLog(itemId, data) {
		if (!debugMode) return;
		ensureDir();
		const prefix = dryRun ? 'dry_debug' : 'debug';
		const logFile = path.join(logDir, `${prefix}_${itemId}_${Date.now()}.json`);
		fs.writeFileSync(logFile, JSON.stringify(data, null, 2));
		console.log(`  Debug log written to ${logFile}\n`);
	}

	function addResult(entry) {
		if (runLog) runLog.results.push(entry);
	}

	function writeRunLog(summary) {
		if (!runLog) return;
		runLog.summary = summary;
		ensureDir();
		const prefix = dryRun ? 'dry_run' : 'run';
		const logFile = path.join(logDir, `${prefix}_${Date.now()}.json`);
		fs.writeFileSync(logFile, JSON.stringify(runLog, null, 2));
		console.log(`\nRun log written to ${logFile}`);
	}

	return { writeDebugLog, addResult, writeRunLog };
}

module.exports = { createLogger };
