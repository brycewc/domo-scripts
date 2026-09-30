const fs = require('fs');
const path = require('path');
const { env, instance } = require('./config');

// Logs are written under the consuming project's working directory, not this
// package's install location, so they land in the project running the tool.
const LOGS_DIR = path.join(process.cwd(), 'logs');

// Bump when the run log shape changes in a way lib/plan.js must know about.
const PLAN_VERSION = 1;
const CHECKPOINT_MS = 30000;

/**
 * Create a logger for a specific command. Writes a run log for every run, plus
 * per-item debug logs in single-ID mode. Run logs are what --from-dry-run and
 * --retry-errors read.
 *
 * @param {string} commandName - Used as the subdirectory under logs/
 * @param {object} options
 * @param {boolean} options.debugMode  - If true, writes per-item debug logs
 * @param {boolean} options.dryRun     - If true, prefixes log filenames with "dry_"
 * @param {object}  [options.runMeta]  - Extra metadata to include in the run log header
 * @param {object}  [options.instances] - For two-instance commands. Shape:
 *                                       { source: { env, instance }, target: { env, instance } }
 *                                       When present, replaces the single-instance env/instance
 *                                       fields in run logs and debug logs.
 * @param {object}  [options.source]   - The result of loadSource() when this run replays a
 *                                       dry run or retries a run. Stamps fromPlan / retryOf.
 */
function createLogger(commandName, options = {}) {
	const { debugMode = false, dryRun = false, runMeta = {}, instances, source } = options;
	const logDir = path.join(LOGS_DIR, commandName);
	const stamp = instances ? { instances } : { env, instance };
	const startedAt = Date.now();
	const runLogFile = path.join(logDir, `${dryRun ? 'dry_run' : 'run'}_${startedAt}.json`);

	const sourceStamp = {};
	if (source) {
		sourceStamp[source.mode === 'from-dry-run' ? 'fromPlan' : 'retryOf'] = source.relPath;
	}

	const runLog = {
		timestamp: new Date(startedAt).toISOString(),
		command: commandName,
		planVersion: PLAN_VERSION,
		...stamp,
		...sourceStamp,
		...runMeta,
		dryRun,
		results: []
	};

	let plan = null;
	let planKey = null;
	const processed = new Set();
	let timer = null;
	let finalized = false;

	function ensureDir() {
		fs.mkdirSync(logDir, { recursive: true });
	}

	function writeDebugLog(itemId, data) {
		if (!debugMode) return;
		ensureDir();
		const prefix = dryRun ? 'dry_debug' : 'debug';
		const logFile = path.join(logDir, `${prefix}_${itemId}_${Date.now()}.json`);
		const payload = { ...stamp, ...data };
		fs.writeFileSync(logFile, JSON.stringify(payload, null, 2));
		console.log(`  Debug log written to ${logFile}\n`);
	}

	function addResult(entry) {
		if (!runLog) return;
		runLog.results.push(entry);
		track(entry);
	}

	function track(row) {
		if (!planKey) return;
		// Batch-level rows may not carry the fields keyOf reads.
		try {
			processed.add(planKey(row));
		} catch (_) {}
	}

	// For commands that only log failures, or log one row per batch.
	function markProcessed(entries) {
		if (!planKey) return;
		for (const entry of entries) processed.add(planKey(entry));
	}

	function unreachedEntries() {
		if (!plan) return [];
		return plan.filter((entry) => !processed.has(planKey(entry)));
	}

	function writeFile(payload) {
		ensureDir();
		// Write-then-rename so a crash mid-write never leaves a truncated log.
		const tmp = `${runLogFile}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
		fs.renameSync(tmp, runLogFile);
	}

	function checkpoint() {
		const unreached = unreachedEntries();
		writeFile({
			...runLog,
			summary: { incomplete: true, processed: processed.size, unreached: unreached.length },
			unreached
		});
	}

	function onExit() {
		if (finalized) return;
		checkpoint();
		console.error(`\nRun stopped early. Partial run log written to ${runLogFile}`);
		console.error('Re-run with --retry-errors to finish the failed and unreached items.');
	}

	function onSignal() {
		process.exit(130);
	}

	// Call after confirmation, before the first mutation. keyOf is also applied
	// to result rows, so each row must carry the entry's identifying fields.
	function beginExecution(entries, keyOf) {
		if (!runLog || dryRun) return;
		if (!plan) {
			plan = [];
			planKey = keyOf;
			for (const row of runLog.results) track(row);
			timer = setInterval(checkpoint, CHECKPOINT_MS);
			timer.unref();
			process.on('exit', onExit);
			process.once('SIGINT', onSignal);
			process.once('SIGTERM', onSignal);
		}
		for (const entry of entries) plan.push(entry);
		checkpoint();
	}

	function writeRunLog(summary) {
		if (!runLog) return;
		finalized = true;
		if (timer) clearInterval(timer);
		process.removeListener('exit', onExit);
		process.removeListener('SIGINT', onSignal);
		process.removeListener('SIGTERM', onSignal);

		const unreached = unreachedEntries();
		const payload = { ...runLog, summary };
		if (unreached.length > 0) {
			payload.summary = { ...summary, incomplete: true, unreached: unreached.length };
			payload.unreached = unreached;
		}
		writeFile(payload);
		console.log(`\nRun log written to ${runLogFile}`);
		if (unreached.length > 0) {
			console.log(`${unreached.length} planned item(s) were never reached. Re-run with --retry-errors to finish them.`);
		}
		const discoveryErrors = runLog.results.filter((r) => r.status === 'error' && r.phase === 'discover').length;
		if (!dryRun && discoveryErrors > 0) {
			console.log(
				`${discoveryErrors} error(s) happened before any change was attempted; --retry-errors skips those, so re-run them normally.`
			);
		}
	}

	return { writeDebugLog, addResult, markProcessed, beginExecution, writeRunLog };
}

module.exports = { createLogger, LOGS_DIR, PLAN_VERSION };
