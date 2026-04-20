/**
 * Bulk update Domo stream schedules
 *
 * Modes:
 *   daily  (default) — streams running more than once a day get changed to once daily
 *                       at a random time within --start-hour/--end-hour
 *   manual           — all streams in the input are set to MANUAL schedule
 *
 * Usage:
 *   node cli.js bulk-update-stream-schedules --file "streams.csv" --start-hour 6 --end-hour 20
 *   node cli.js bulk-update-stream-schedules --file "streams.csv" --column "id" --start-hour 6 --end-hour 20 --timezone "America/Denver"
 *   node cli.js bulk-update-stream-schedules --file "streams.csv" --filter-column "status" --filter-value "ACTIVE" --start-hour 6 --end-hour 20
 *   node cli.js bulk-update-stream-schedules --stream-id 119533 --start-hour 6 --end-hour 20
 *   node cli.js bulk-update-stream-schedules --stream-ids "119533,110462" --start-hour 6 --end-hour 20
 *   node cli.js bulk-update-stream-schedules --file "streams.csv" --mode manual
 *
 * Options:
 *   --file, -f        CSV file with stream IDs
 *   --stream-id       Single stream ID (enables debug logging)
 *   --stream-ids      Comma-separated stream IDs
 *   --column, -c      Column name containing stream IDs (default: "streamId")
 *   --mode            "daily" (default) or "manual"
 *   --start-hour      Start of hour range, 0-23 (default: 0, daily mode only)
 *   --end-hour        End of hour range, 0-23 (default: 23, daily mode only)
 *   --timezone        Timezone for the schedule (default: "UTC")
 *   --filter-column   CSV column to filter on (optional, requires --filter-value)
 *   --filter-value    Value the filter-column must equal to include the row
 *   --dry-run         Preview changes without applying them
 */

const api = require('../lib/api');
const { resolveIds } = require('../lib/input');
const { createLogger } = require('../lib/log');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-update-stream-schedules [options]

Options:
  --file, -f        CSV file with stream IDs
  --stream-id       Single stream ID (enables debug logging)
  --stream-ids      Comma-separated stream IDs
  --column, -c      CSV column with stream IDs (default: "streamId")
  --mode            "daily" (default) or "manual"
  --start-hour      Start of hour range, 0-23 (default: 0)
  --end-hour        End of hour range, 0-23 (default: 23)
  --timezone        Schedule timezone (default: "UTC")
  --filter-column   CSV column to filter on
  --filter-value    Value the filter-column must equal
  --dry-run         Preview changes without applying`;

// -- Schedule helpers --------------------------------------------------------

const MORE_THAN_DAILY_TYPES = ['MINUTE', 'HOUR'];

function isMoreThanOnceADay(advancedScheduleJson) {
	try {
		const schedule = JSON.parse(advancedScheduleJson);
		if (MORE_THAN_DAILY_TYPES.includes(schedule.type)) return true;
		if (schedule.type === 'ADVANCED' && schedule.interval != null) return true;
		return false;
	} catch {
		return false;
	}
}

function generateRandomTime(startHour, endHour) {
	const hour =
		Math.floor(Math.random() * (endHour - startHour + 1)) + startHour;
	const minute = Math.floor(Math.random() * 60);
	const period = hour >= 12 ? 'PM' : 'AM';
	const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
	const paddedMinute = String(minute).padStart(2, '0');
	return `${String(displayHour).padStart(2, '0')}:${paddedMinute} ${period}`;
}

function modifyScheduleToDaily(streamDefinition, startHour, endHour, timezone) {
	const at = generateRandomTime(startHour, endHour);
	const currentSchedule = JSON.parse(
		streamDefinition.advancedScheduleJson || '{}'
	);

	let newSchedule;
	if (currentSchedule.type === 'ADVANCED') {
		// Keep as ADVANCED type but switch from interval-based to time-based,
		// preserving existing month/dayOfMonth/dayOfWeek/weekOfMonths values
		newSchedule = {
			type: 'ADVANCED',
			month: currentSchedule.month || [],
			dayOfMonth: currentSchedule.dayOfMonth || [],
			dayOfWeek: currentSchedule.dayOfWeek || [],
			weekOfMonths: currentSchedule.weekOfMonths || [],
			time: at,
			timezone
		};
	} else {
		newSchedule = {
			type: 'DAY',
			at,
			timezone
		};
	}

	streamDefinition.advancedScheduleJson = JSON.stringify(newSchedule);

	console.log(
		`  Set advancedScheduleJson to ${streamDefinition.advancedScheduleJson}`
	);

	return streamDefinition;
}

function modifyScheduleToManual(streamDefinition) {
	streamDefinition.scheduleState = 'MANUAL';
	streamDefinition.advancedScheduleJson = JSON.stringify({
		type: 'MANUAL',
		timezone: 'UTC'
	});

	console.log('  Set scheduleState to MANUAL');
	console.log(
		'  Set advancedScheduleJson to {"type":"MANUAL","timezone":"UTC"}'
	);

	return streamDefinition;
}

// -- Main --------------------------------------------------------------------

async function main() {
	showHelp(argv, HELP_TEXT);

	const mode = argv.mode || 'daily';
	const startHour = argv['start-hour'] != null ? Number(argv['start-hour']) : 0;
	const endHour = argv['end-hour'] != null ? Number(argv['end-hour']) : 23;
	const timezone = argv.timezone || 'UTC';
	const dryRun = argv['dry-run'] || false;

	if (!['daily', 'manual'].includes(mode)) {
		console.error('Error: --mode must be "daily" or "manual"');
		process.exit(1);
	}

	if (
		mode === 'daily' &&
		(startHour < 0 ||
			startHour > 23 ||
			endHour < 0 ||
			endHour > 23 ||
			startHour > endHour)
	) {
		console.error(
			'Error: --start-hour and --end-hour must be 0-23, and start-hour <= end-hour'
		);
		process.exit(1);
	}

	const { ids: streamIds, debugMode } = resolveIds(argv, {
		name: 'stream',
		columnDefault: 'streamId'
	});

	const logger = createLogger('updateStreamSchedules', {
		debugMode,
		dryRun,
		runMeta: {
			file: argv.file || argv.f || null,
			column: argv.column || argv.c || 'streamId',
			mode,
			startHour: mode === 'daily' ? startHour : undefined,
			endHour: mode === 'daily' ? endHour : undefined,
			timezone,
			totalStreams: streamIds.length
		}
	});

	const modeLabel = mode === 'manual' ? 'MANUAL' : 'Once Daily';
	console.log(`Bulk Update Stream Schedules to ${modeLabel}`);
	console.log('==========================================\n');
	console.log(`Mode: ${mode}`);
	if (mode === 'daily') {
		console.log(
			`Random time range: ${startHour}:00 - ${endHour}:59 ${timezone}`
		);
		console.log(`Timezone: ${timezone}`);
	}
	if (dryRun) console.log('DRY RUN (no changes will be made)');
	console.log(`Found ${streamIds.length} stream(s) to process\n`);

	let successCount = 0;
	let skipCount = 0;
	let errorCount = 0;

	for (let i = 0; i < streamIds.length; i++) {
		const streamId = streamIds[i];
		const progress = `[${i + 1}/${streamIds.length}]`;
		console.log(`${progress} Processing stream ${streamId}...`);

		const debugLog = debugMode
			? { streamId, timestamp: new Date().toISOString() }
			: null;

		const entry = { streamId, status: null, name: null, error: null };

		try {
			console.log('  Fetching stream definition...');
			const streamDefinition = await api.get(
				`/data/v1/streams/${streamId}?fields=all`
			);
			const name =
				streamDefinition.dataSource?.name ||
				streamDefinition.name ||
				'Unnamed';
			entry.name = name;
			console.log(`  Name: "${name}"`);

			const currentSchedule =
				streamDefinition.advancedScheduleJson || '{}';
			console.log(`  Current advancedScheduleJson: ${currentSchedule}`);
			console.log(
				`  Current scheduleExpression: ${streamDefinition.scheduleExpression || 'Not set'}`
			);

			if (debugLog) {
				debugLog.originalScheduleJson = currentSchedule;
				debugLog.originalScheduleExpression =
					streamDefinition.scheduleExpression;
			}

			if (mode === 'daily' && !isMoreThanOnceADay(currentSchedule)) {
				const parsed = JSON.parse(currentSchedule);
				console.log(
					`  Skipped — schedule type "${parsed.type}" does not run more than once a day\n`
				);
				entry.status = 'skipped';
				if (debugLog) debugLog.skipped = true;
				skipCount++;
			} else if (dryRun) {
				if (mode === 'manual') {
					console.log(
						`  [DRY RUN] Would change to MANUAL schedule\n`
					);
				} else {
					const previewTime = generateRandomTime(startHour, endHour);
					console.log(
						`  [DRY RUN] Would change to daily at ${previewTime} ${timezone}\n`
					);
					entry.previewTime = previewTime;
					if (debugLog) debugLog.previewTime = previewTime;
				}
				entry.status = 'dry-run';
				if (debugLog) debugLog.dryRun = true;
				successCount++;
			} else {
				let modifiedDefinition;
				if (mode === 'manual') {
					modifiedDefinition =
						modifyScheduleToManual(streamDefinition);
				} else {
					modifiedDefinition = modifyScheduleToDaily(
						streamDefinition,
						startHour,
						endHour,
						timezone
					);
				}

				if (debugLog) {
					debugLog.newScheduleJson =
						modifiedDefinition.advancedScheduleJson;
					debugLog.newScheduleState =
						modifiedDefinition.scheduleState;
				}

				console.log('  Updating stream...');
				const result = await api.put(
					`/data/v1/streams/${streamId}`,
					modifiedDefinition
				);
				console.log(`  Successfully updated\n`);
				entry.status = 'updated';
				entry.newScheduleJson =
					modifiedDefinition.advancedScheduleJson;

				if (debugLog) {
					debugLog.putResponse = {
						scheduleExpression: result.scheduleExpression,
						advancedScheduleJson: result.advancedScheduleJson,
						scheduleState: result.scheduleState
					};
				}
				successCount++;
			}
		} catch (error) {
			console.error(`  Error: ${error.message}\n`);
			entry.status = 'error';
			entry.error = error.message;
			if (debugLog) debugLog.error = error.message;
			errorCount++;
		}

		if (debugLog) {
			logger.writeDebugLog(`stream_${streamId}`, debugLog);
		}

		logger.addResult(entry);

		if (i < streamIds.length - 1) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	console.log('=== Summary ===');
	console.log(`Total streams processed: ${streamIds.length}`);
	console.log(`Successfully updated: ${successCount}`);
	console.log(`Skipped (already daily or less frequent): ${skipCount}`);
	console.log(`Errors: ${errorCount}`);

	logger.writeRunLog({ successCount, skipCount, errorCount });

	if (errorCount > 0) {
		console.error(
			'\nSome streams failed to update. Check the error messages above.'
		);
		process.exit(1);
	} else {
		console.log('\nAll streams processed successfully!');
	}
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});
