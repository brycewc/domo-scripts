/**
 * Bulk update Domo stream schedules
 *
 * Modes:
 *   daily  (default) — streams running more than once a day get changed to once daily
 *                       at a random time within --start-hour/--end-hour. Manually
 *                       scheduled streams are skipped unless --include-manual is set.
 *   manual           — all streams in the input are set to MANUAL schedule
 *   from-file        — each stream is set to the schedule supplied in --file. The CSV
 *                       must contain a stream ID column plus at least one of
 *                       advancedScheduleJson or scheduleExpression. scheduleState
 *                       defaults to ACTIVE so the schedule actually fires; provide
 *                       a scheduleState column to override per row.
 *
 * Usage:
 *   node cli.js bulk-update-stream-schedules --file "streams.csv" --start-hour 6 --end-hour 20
 *   node cli.js bulk-update-stream-schedules --file "streams.csv" --column "id" --start-hour 6 --end-hour 20 --timezone "America/Denver"
 *   node cli.js bulk-update-stream-schedules --file "streams.csv" --filter-column "status" --filter-value "ACTIVE" --start-hour 6 --end-hour 20
 *   node cli.js bulk-update-stream-schedules --stream-id 119533 --start-hour 6 --end-hour 20
 *   node cli.js bulk-update-stream-schedules --stream-ids "119533,110462" --start-hour 6 --end-hour 20
 *   node cli.js bulk-update-stream-schedules --file "streams.csv" --start-hour 6 --end-hour 20 --include-manual
 *   node cli.js bulk-update-stream-schedules --file "streams.csv" --mode manual
 *   node cli.js bulk-update-stream-schedules --mode from-file --file "restore.csv" --column "Stream ID" --schedule-expression-column "Schedule Expression" --schedule-json-column "advancedScheduleJson"
 *
 * Options:
 *   --file, -f                       CSV file with stream IDs (and schedules in from-file mode)
 *   --stream-id                      Single stream ID (enables debug logging)
 *   --stream-ids                     Comma-separated stream IDs
 *   --column, -c                     Column name containing stream IDs (default: "streamId")
 *   --mode                           "daily" (default), "manual", or "from-file"
 *   --start-hour                     Start of hour range, 0-23 (default: 0, daily mode only)
 *   --end-hour                       End of hour range, 0-23 (default: 23, daily mode only)
 *   --timezone                       Timezone for the schedule (default: "UTC")
 *   --include-manual                 In daily mode, also convert MANUAL streams to a daily schedule
 *                                      (activates them) instead of skipping them
 *   --schedule-json-column           Column with advancedScheduleJson (default: "advancedScheduleJson", from-file only)
 *   --schedule-expression-column     Column with scheduleExpression cron (default: "scheduleExpression", from-file only)
 *   --schedule-state-column          Column with scheduleState override (default: "scheduleState", from-file only)
 *   --filter-column                  CSV column to filter on (optional, requires --filter-value)
 *   --filter-value                   Value the filter-column must equal to include the row
 *   --dry-run                        Preview changes without applying them
 */

const api = require('../lib/api');
const { readCSV } = require('../lib/csv');
const { resolveIds } = require('../lib/input');
const { createLogger } = require('../lib/log');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-update-stream-schedules [options]

Options:
  --file, -f                    CSV file with stream IDs (and schedules in from-file mode)
  --stream-id                   Single stream ID (enables debug logging)
  --stream-ids                  Comma-separated stream IDs
  --column, -c                  CSV column with stream IDs (default: "streamId")
  --mode                        "daily" (default), "manual", or "from-file"
  --start-hour                  Start of hour range, 0-23 (default: 0)
  --end-hour                    End of hour range, 0-23 (default: 23)
  --timezone                    Schedule timezone (default: "UTC")
  --include-manual              In daily mode, also convert MANUAL streams to a daily schedule
  --schedule-json-column        Column with advancedScheduleJson (default: "advancedScheduleJson")
  --schedule-expression-column  Column with scheduleExpression cron (default: "scheduleExpression")
  --schedule-state-column       Column with scheduleState override (default: "scheduleState")
  --filter-column               CSV column to filter on
  --filter-value                Value the filter-column must equal
  --dry-run                     Preview changes without applying`;

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
		// preserving existing month/dayOfMonth/dayOfWeek/weekOfMonths values.
		// Only include dayOfMonth when it has values — sending an empty array
		// alongside a populated dayOfWeek triggers a server NPE
		// ("Cannot read field 'scheduler'..."). The UI omits it in that case.
		newSchedule = {
			type: 'ADVANCED',
			month:
				Array.isArray(currentSchedule.month) && currentSchedule.month.length
					? currentSchedule.month
					: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
			dayOfWeek:
				Array.isArray(currentSchedule.dayOfWeek) &&
				currentSchedule.dayOfWeek.length
					? currentSchedule.dayOfWeek
					: [1, 2, 3, 4, 5, 6, 7],
			weekOfMonths: Array.isArray(currentSchedule.weekOfMonths)
				? currentSchedule.weekOfMonths
				: [],
			time: at,
			timezone
		};
		if (
			Array.isArray(currentSchedule.dayOfMonth) &&
			currentSchedule.dayOfMonth.length
		) {
			newSchedule.dayOfMonth = currentSchedule.dayOfMonth;
		}
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

	// MANUAL streams have scheduleState='MANUAL', which suppresses the schedule.
	// Flip to ACTIVE so the new daily schedule actually fires.
	if (currentSchedule.type === 'MANUAL' || streamDefinition.scheduleState === 'MANUAL') {
		streamDefinition.scheduleState = 'ACTIVE';
		console.log('  Set scheduleState to ACTIVE');
	}

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

function modifyScheduleFromFile(streamDefinition, schedule) {
	if (schedule.advancedScheduleJson) {
		streamDefinition.advancedScheduleJson = schedule.advancedScheduleJson;
		console.log(
			`  Set advancedScheduleJson to ${schedule.advancedScheduleJson}`
		);
	}
	if (schedule.scheduleExpression) {
		streamDefinition.scheduleExpression = schedule.scheduleExpression;
		console.log(
			`  Set scheduleExpression to ${schedule.scheduleExpression}`
		);
	}
	streamDefinition.scheduleState = schedule.scheduleState || 'ACTIVE';
	console.log(`  Set scheduleState to ${streamDefinition.scheduleState}`);

	return streamDefinition;
}

/**
 * Read a CSV mapping stream IDs to schedules. Returns:
 *   { ids: string[], schedules: Map<string, {advancedScheduleJson, scheduleExpression, scheduleState}> }
 *
 * Rows are skipped (with a warning) if they have no ID or no schedule data.
 */
function loadSchedulesFromFile(filePath, opts) {
	const records = readCSV(filePath, {
		filterColumn: opts.filterColumn,
		filterValue: opts.filterValue
	});

	const columns = Object.keys(records[0] || {});
	if (!columns.includes(opts.idColumn)) {
		throw new Error(
			`ID column "${opts.idColumn}" not found in CSV. Available columns: ${columns.join(', ')}`
		);
	}
	const hasJson = columns.includes(opts.jsonColumn);
	const hasExpr = columns.includes(opts.expressionColumn);
	if (!hasJson && !hasExpr) {
		throw new Error(
			`CSV must contain at least one schedule column ("${opts.jsonColumn}" or "${opts.expressionColumn}"). Available columns: ${columns.join(', ')}`
		);
	}
	const hasState = columns.includes(opts.stateColumn);

	const ids = [];
	const schedules = new Map();
	let skippedNoSchedule = 0;

	for (const row of records) {
		const id = String(row[opts.idColumn] || '').trim();
		if (!id) continue;

		const advancedScheduleJson = hasJson
			? String(row[opts.jsonColumn] || '').trim()
			: '';
		const scheduleExpression = hasExpr
			? String(row[opts.expressionColumn] || '').trim()
			: '';
		const scheduleState = hasState
			? String(row[opts.stateColumn] || '').trim()
			: '';

		if (!advancedScheduleJson && !scheduleExpression) {
			skippedNoSchedule++;
			continue;
		}

		schedules.set(id, {
			advancedScheduleJson: advancedScheduleJson || null,
			scheduleExpression: scheduleExpression || null,
			scheduleState: scheduleState || null
		});
		ids.push(id);
	}

	if (skippedNoSchedule > 0) {
		console.log(
			`Skipped ${skippedNoSchedule} row(s) with no schedule data (neither "${opts.jsonColumn}" nor "${opts.expressionColumn}" set)`
		);
	}

	return { ids, schedules };
}

// -- Main --------------------------------------------------------------------

async function main() {
	showHelp(argv, HELP_TEXT);

	const mode = argv.mode || 'daily';
	const startHour = argv['start-hour'] != null ? Number(argv['start-hour']) : 0;
	const endHour = argv['end-hour'] != null ? Number(argv['end-hour']) : 23;
	const timezone = argv.timezone || 'UTC';
	const includeManual = argv['include-manual'] || false;
	const dryRun = argv['dry-run'] || false;

	if (!['daily', 'manual', 'from-file'].includes(mode)) {
		console.error('Error: --mode must be "daily", "manual", or "from-file"');
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

	const idColumn = argv.column || argv.c || 'streamId';
	const jsonColumn =
		argv['schedule-json-column'] || 'advancedScheduleJson';
	const expressionColumn =
		argv['schedule-expression-column'] || 'scheduleExpression';
	const stateColumn = argv['schedule-state-column'] || 'scheduleState';

	let streamIds;
	let debugMode;
	let scheduleMap = null;

	if (mode === 'from-file') {
		const filePath = argv.file || argv.f;
		if (!filePath) {
			console.error('Error: --file is required when --mode from-file');
			process.exit(1);
		}
		if (argv['stream-id'] || argv['stream-ids']) {
			console.error(
				'Error: --stream-id and --stream-ids are not supported in from-file mode (the file provides both IDs and schedules)'
			);
			process.exit(1);
		}
		const loaded = loadSchedulesFromFile(filePath, {
			idColumn,
			jsonColumn,
			expressionColumn,
			stateColumn,
			filterColumn: argv['filter-column'],
			filterValue: argv['filter-value']
		});
		streamIds = loaded.ids;
		scheduleMap = loaded.schedules;
		debugMode = streamIds.length === 1;
	} else {
		({ ids: streamIds, debugMode } = resolveIds(argv, {
			name: 'stream',
			columnDefault: 'streamId'
		}));
	}

	const logger = createLogger('bulk-update-stream-schedules', {
		debugMode,
		dryRun,
		runMeta: {
			file: argv.file || argv.f || null,
			column: idColumn,
			mode,
			startHour: mode === 'daily' ? startHour : undefined,
			endHour: mode === 'daily' ? endHour : undefined,
			timezone,
			includeManual: mode === 'daily' ? includeManual : undefined,
			scheduleJsonColumn: mode === 'from-file' ? jsonColumn : undefined,
			scheduleExpressionColumn:
				mode === 'from-file' ? expressionColumn : undefined,
			scheduleStateColumn:
				mode === 'from-file' ? stateColumn : undefined,
			totalStreams: streamIds.length
		}
	});

	const modeLabel =
		mode === 'manual'
			? 'MANUAL'
			: mode === 'from-file'
				? 'From File'
				: 'Once Daily';
	console.log(`Bulk Update Stream Schedules to ${modeLabel}`);
	console.log('==========================================\n');
	console.log(`Mode: ${mode}`);
	if (mode === 'daily') {
		console.log(
			`Random time range: ${startHour}:00 - ${endHour}:59 ${timezone}`
		);
		console.log(`Timezone: ${timezone}`);
		if (includeManual) {
			console.log(
				'Include manual: MANUAL streams will be converted to daily (and activated)'
			);
		}
	}
	if (mode === 'from-file') {
		console.log(`Schedule file: ${argv.file || argv.f}`);
		console.log(`ID column: "${idColumn}"`);
		console.log(`JSON column: "${jsonColumn}"`);
		console.log(`Expression column: "${expressionColumn}"`);
		console.log(`State column: "${stateColumn}" (defaults to ACTIVE)`);
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

			let parsedCurrent = {};
			try {
				parsedCurrent = JSON.parse(currentSchedule);
			} catch {
				/* leave empty */
			}
			const isManual = parsedCurrent.type === 'MANUAL';
			const shouldProcessForDaily =
				mode === 'daily' &&
				(isMoreThanOnceADay(currentSchedule) || (includeManual && isManual));

			const fileSchedule =
				mode === 'from-file' ? scheduleMap.get(String(streamId)) : null;

			if (mode === 'daily' && !shouldProcessForDaily) {
				const reason = isManual
					? 'is MANUAL (use --include-manual to convert)'
					: `type "${parsedCurrent.type}" does not run more than once a day`;
				console.log(`  Skipped — schedule ${reason}\n`);
				entry.status = 'skipped';
				if (debugLog) debugLog.skipped = true;
				skipCount++;
			} else if (mode === 'from-file' && !fileSchedule) {
				console.log(
					`  Skipped — no schedule found in file for stream ${streamId}\n`
				);
				entry.status = 'skipped';
				if (debugLog) debugLog.skipped = true;
				skipCount++;
			} else if (dryRun) {
				if (mode === 'manual') {
					console.log(
						`  [DRY RUN] Would change to MANUAL schedule\n`
					);
				} else if (mode === 'from-file') {
					const previewParts = [];
					if (fileSchedule.advancedScheduleJson) {
						previewParts.push(
							`advancedScheduleJson=${fileSchedule.advancedScheduleJson}`
						);
					}
					if (fileSchedule.scheduleExpression) {
						previewParts.push(
							`scheduleExpression=${fileSchedule.scheduleExpression}`
						);
					}
					previewParts.push(
						`scheduleState=${fileSchedule.scheduleState || 'ACTIVE'}`
					);
					console.log(
						`  [DRY RUN] Would set ${previewParts.join(', ')}\n`
					);
					entry.previewSchedule = fileSchedule;
					if (debugLog) debugLog.previewSchedule = fileSchedule;
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
				} else if (mode === 'from-file') {
					modifiedDefinition = modifyScheduleFromFile(
						streamDefinition,
						fileSchedule
					);
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

	const skipLabel =
		mode === 'from-file'
			? 'Skipped (no schedule in file)'
			: 'Skipped (already daily or less frequent)';
	console.log('=== Summary ===');
	console.log(`Total streams processed: ${streamIds.length}`);
	console.log(`Successfully updated: ${successCount}`);
	console.log(`${skipLabel}: ${skipCount}`);
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
