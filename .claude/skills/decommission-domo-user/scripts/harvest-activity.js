#!/usr/bin/env node
/**
 * Day-chunked activity-log harvester for a user decommission.
 *
 * Encodes three findings that are easy to get wrong:
 *   1. /audit/v1/user-audits accepts ONE objectType per call. A comma-separated
 *      list returns zero rows and no error.
 *   2. The endpoint carries ~150s of fixed latency but tolerates ~8 concurrent
 *      requests, so day chunks run through a worker pool.
 *   3. Views by the operator, by the target account, and by Domo's MajorDomo
 *      service account are not usage and are excluded from every aggregate.
 *
 * Writes one JSON aggregate per object type: { objectId: { views, engaged,
 * viewers: {...}, lastView, lastEngaged } } where `engaged` counts deliberate
 * actions (anything that is not a VIEWED event).
 *
 * Usage, from the repo root:
 *   node .claude/skills/decommission-domo-user/scripts/harvest-activity.js \
 *     --target 904714859 --days 180 --types CARD,PAGE,DATA_APP_VIEW \
 *     --out logs/cleanup-904714859 [--exclude 1813188617] [--concurrency 8]
 */
const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { api, config } = require('../../../../lib');

const argv = minimist(process.argv.slice(2), {
	string: ['target', 'types', 'out', 'exclude'],
	default: { days: 180, concurrency: 8, types: 'CARD,PAGE,DATA_APP_VIEW' }
});

if (argv.help || !argv.target) {
	if (!argv.help) console.error('Missing required --target\n');
	console.log(`Harvest attributed activity for a user decommission.

Required:
  --target <userId>       the account being decommissioned (its own views are excluded)

Optional:
  --days <n>              window length, default 180
  --types <csv>           object types, one API call each. Default CARD,PAGE,DATA_APP_VIEW
  --out <dir>             output directory, default logs/cleanup-<target>
  --exclude <csv>         extra user ids whose views do not count (e.g. yourself)
  --concurrency <n>       parallel day-chunks, default 8
  --help`);
	process.exit(argv.help ? 0 : 1);
}

const TARGET = String(argv.target);
const OUT = argv.out || path.join('logs', `cleanup-${TARGET}`);
const TYPES = String(argv.types).split(',').map((t) => t.trim()).filter(Boolean);
const EXCLUDE = new Set([TARGET, ...String(argv.exclude || '').split(',').map((s) => s.trim()).filter(Boolean)]);
const CONCURRENCY = Math.max(1, Number(argv.concurrency) || 8);
const DAY = 86400000;

// MajorDomo is platform automation, not a person. Its owner churn and reshares
// look like engagement and will revive dead objects if counted.
const isAutomation = (name) => /majordomo/i.test(name || '');

async function fetchChunk(objectType, start, end) {
	const rows = [];
	let offset = 0;
	const limit = 1000;
	for (;;) {
		const page = await api.get(
			`/audit/v1/user-audits?start=${start}&end=${end}&objectType=${objectType}&limit=${limit}&offset=${offset}`
		);
		const batch = Array.isArray(page) ? page : (page && page.audits) || [];
		rows.push(...batch);
		if (batch.length < limit) break;
		offset += limit;
	}
	return rows;
}

function fold(agg, rows) {
	for (const r of rows) {
		const objectId = String(r.objectId != null ? r.objectId : r.objectID || '');
		if (!objectId) continue;
		const actorId = String(r.userId != null ? r.userId : r.actorId || '');
		const actorName = r.userName || r.actorName || '';
		if (EXCLUDE.has(actorId) || isAutomation(actorName)) continue;

		const bucket = agg[objectId] || (agg[objectId] = {
			views: 0, engaged: 0, viewers: {}, lastView: null, lastEngaged: null,
			objectName: r.objectName || r.objectTitle || ''
		});
		// the audit row's timestamp is `time` (epoch ms) and its event is `actionType`
		const when = r.time != null ? new Date(r.time).toISOString() : null;
		const isView = String(r.actionType || '').toUpperCase() === 'VIEWED';
		if (isView) {
			bucket.views++;
			if (!bucket.lastView || when > bucket.lastView) bucket.lastView = when;
		} else {
			bucket.engaged++;
			if (!bucket.lastEngaged || when > bucket.lastEngaged) bucket.lastEngaged = when;
		}
		bucket.viewers[actorName || actorId] = (bucket.viewers[actorName || actorId] || 0) + 1;
	}
}

(async () => {
	config.requireAuth();
	fs.mkdirSync(OUT, { recursive: true });
	const end = Date.now();
	const start = end - Number(argv.days) * DAY;
	const chunks = [];
	for (let t = start; t < end; t += DAY) chunks.push([t, Math.min(t + DAY, end)]);

	console.log(`instance ${config.instance} | target ${TARGET} | ${argv.days}d | ${chunks.length} day-chunks`);
	console.log(`excluding views by: ${[...EXCLUDE].join(', ')} + any MajorDomo service account\n`);

	for (const objectType of TYPES) {
		const agg = {};
		let scanned = 0, failed = [];
		let cursor = 0;
		const worker = async () => {
			for (;;) {
				const i = cursor++;
				if (i >= chunks.length) return;
				const [s, e] = chunks[i];
				try {
					const rows = await fetchChunk(objectType, s, e);
					// fold synchronously so concurrent workers cannot interleave a read-modify-write
					const n = rows.length;
					fold(agg, rows);
					scanned += n;
				} catch (err) {
					failed.push({ start: s, end: e, error: err.message.slice(0, 160) });
				}
				process.stderr.write(`\r  ${objectType}: ${i + 1}/${chunks.length} chunks, ${scanned} events, ${failed.length} failed`);
			}
		};
		await Promise.all(Array.from({ length: CONCURRENCY }, worker));
		process.stderr.write('\n');

		const file = path.join(OUT, `activity_${objectType}.json`);
		fs.writeFileSync(file, JSON.stringify(agg, null, 1));
		const objects = Object.keys(agg).length;
		const touched = Object.values(agg).filter((a) => a.views > 0 || a.engaged > 0).length;
		console.log(`  -> ${file}: ${objects} objects with third-party activity (${touched} with a view or action)`);
		if (failed.length) {
			const ff = path.join(OUT, `activity_${objectType}_failed.json`);
			fs.writeFileSync(ff, JSON.stringify(failed, null, 1));
			console.log(`  !! ${failed.length} chunk(s) failed, written to ${ff}. Re-run those before trusting any zero.`);
		}
	}
	console.log('\nA zero here means "no attributed third-party activity in the window", not "unused".');
	console.log('Join each object to its container before judging, and re-verify live before deleting.');
})().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
