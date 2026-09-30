/**
 * Transfer a Domo stream from one instance to another.
 *
 * Fetches each source stream via the source instance's API, strips/rewrites
 * instance-specific fields, then POSTs it to the target instance. Records the
 * resulting old→new IDs in id-mappings/<sourceEnv>_to_<targetEnv>.json so that
 * future transfer commands (datasets, dataflows, etc.) can resolve references.
 *
 * Usage:
 *   node cli.js transfer-stream --source-env prod --target-env sandbox --stream-id 12345
 *   node cli.js transfer-stream --source-env prod --target-env sandbox --stream-ids 1,2,3
 *   node cli.js transfer-stream --source-env prod --target-env sandbox --file streams.csv
 *   node cli.js transfer-stream --source-env prod --target-env sandbox --stream-id 12345 --dry-run
 *   node cli.js transfer-stream --source-env prod --target-env sandbox --retry-errors
 */

const argv = require('minimist')(process.argv.slice(2));
const {
	createApiClient,
	loadEnvConfig,
	resolveIds,
	createLogger,
	loadSource,
	printSource,
	confirmSource,
	showHelp,
	idMapping,
	rewriteDomain
} = require('../lib');

const COMMAND = 'transfer-stream';
const SELECTION_FLAGS = [
	'stream-id',
	'stream-ids',
	'file',
	'f',
	'column',
	'c',
	'filter-column',
	'filter-value',
	'dataset-name',
	'rewrite-domain',
	'dry-run'
];

const HELP_TEXT = `Usage: node cli.js transfer-stream [options]

Copy one or more streams from a source Domo instance to a target instance.
A new input dataset is created on the target; old→new IDs are persisted to
id-mappings/<source>_to_<target>.json.

Required:
  --source-env <name>   Loads .env.<name> for the source instance
  --target-env <name>   Loads .env.<name> for the target instance

ID source (one of):
  --stream-id <id>      Single stream ID (enables debug logging)
  --stream-ids <a,b,c>  Comma-separated stream IDs
  --file <path>         CSV with stream IDs (default column: "Stream ID")

Optional:
  --column <name>       CSV column with stream IDs (default: "Stream ID")
  --filter-column <c>   Filter input CSV rows by column
  --filter-value <v>    Required value for --filter-column
  --dataset-name <name> Override the new input dataset's name. Default is the
                        source stream's dataSource.name verbatim.
  --dry-run             Fetch + transform but skip POST and skip mapping save
  --no-prompt           Don't prompt for missing account mappings; skip those
                        streams instead. Useful for non-interactive runs.
  --rewrite-domain      Replace the source instance's <name>.domo.com hostname
                        with the target's everywhere it appears in the stream
                        body, including JSON-encoded configuration[].value
                        blobs. Useful for Domo-on-Domo (governance) transfers
                        where streams reference URLs back to their own instance.
  --help                Show this help

Retrying an earlier run (pass the same --source-env/--target-env; reuses the
log's dataset name and domain rewrite; streams already in the mapping file are skipped):
  --retry-errors [file] Retry the failed and unreached items of a run (default: the latest run log)
  --max-age <hours>     Allow a source log older than 24 hours

Account translation:
  If the source stream has an account, its ID is looked up under "accounts" in
  id-mappings/<source>_to_<target>.json. If no mapping exists, you'll be
  prompted to enter the matching target-instance account ID, and the answer is
  saved into the mapping file for future runs. Pass --no-prompt to skip
  unmapped streams instead.`;

const SYSTEM_FIELDS = [
	'id',
	'valid',
	'invalidExecutionId',
	'accounts',
	'accountTemplate',
	'schemaDefinition',
	'lastExecution',
	'lastSuccessfulExecution',
	'currentExecution',
	'currentExecutionState',
	'createdAt',
	'createdBy',
	'modifiedAt',
	'modifiedBy',
	'inactiveScheduleCode'
];

async function buildCreateBody(source, mapping, options) {
	const { datasetNameOverride, allowPrompt, sourceLabel, targetLabel } = options;
	const body = JSON.parse(JSON.stringify(source));
	for (const field of SYSTEM_FIELDS) delete body[field];

	if (body.dataProvider) {
		body.dataProvider = {
			id: body.dataProvider.id,
			key: body.dataProvider.key
		};
	}

	if (source.account && source.account.id != null) {
		let newAccountId;
		if (allowPrompt) {
			newAccountId = await idMapping.resolveOrPrompt(mapping, 'accounts', source.account.id, {
				name: source.account.displayName || source.account.name || null,
				sourceLabel,
				targetLabel
			});
		} else {
			newAccountId = idMapping.translate(mapping, 'accounts', source.account.id);
		}
		if (newAccountId == null) {
			const err = new Error(
				`No account mapping for source account.id=${source.account.id} in ${mapping.file}.`
			);
			err.code = 'MISSING_ACCOUNT_MAPPING';
			throw err;
		}
		body.account = { id: newAccountId };
	} else {
		delete body.account;
	}

	const datasetName =
		datasetNameOverride || (source.dataSource && source.dataSource.name) || `Stream ${source.id}`;
	body.dataSource = { name: datasetName, description: '' };

	if (Array.isArray(body.configuration)) {
		for (const entry of body.configuration) delete entry.streamId;
	}

	return body;
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const sourceEnv = argv['source-env'];
	const targetEnv = argv['target-env'];
	if (!sourceEnv || !targetEnv) {
		console.error('Error: --source-env and --target-env are both required.');
		console.error('Run with --help for usage.');
		process.exit(1);
	}
	if (sourceEnv === targetEnv) {
		console.error('Error: --source-env and --target-env must differ.');
		process.exit(1);
	}

	const sourceCfg = loadEnvConfig(sourceEnv);
	const targetCfg = loadEnvConfig(targetEnv);
	const instances = {
		source: { env: sourceCfg.env, instance: sourceCfg.instance },
		target: { env: targetCfg.env, instance: targetCfg.instance }
	};

	const retrySource = loadSource(COMMAND, argv, {
		selectionFlags: SELECTION_FLAGS,
		modes: ['retry-errors'],
		instances,
		toEntries: (row) => (row.sourceStreamId == null ? null : String(row.sourceStreamId))
	});
	const meta = retrySource ? retrySource.meta : null;
	if (meta && !('rewriteDomain' in meta)) {
		console.error(
			`Error: ${retrySource.relPath} predates --retry-errors and does not record --rewrite-domain or --dataset-name. Re-run with the original flags and --stream-ids instead.`
		);
		process.exit(1);
	}

	let streamIds;
	let debugMode = false;
	if (retrySource) {
		streamIds = retrySource.entries;
	} else {
		({ ids: streamIds, debugMode } = resolveIds(argv, {
			name: 'stream',
			columnDefault: 'Stream ID'
		}));
	}

	const dryRun = Boolean(argv['dry-run']);
	// minimist turns --no-prompt into prompt: false.
	const noPrompt = argv.prompt === false || Boolean(argv['no-prompt']);
	const allowPrompt = !noPrompt && !dryRun;
	const shouldRewriteDomain = meta ? Boolean(meta.rewriteDomain) : Boolean(argv['rewrite-domain']);
	const datasetNameOverride = meta ? meta.datasetName || null : argv['dataset-name'] || null;

	const sourceApi = createApiClient(sourceCfg);
	const targetApi = createApiClient(targetCfg);

	const mapping = idMapping.loadMapping(sourceEnv, targetEnv);

	const logger = createLogger(COMMAND, {
		debugMode,
		dryRun,
		instances,
		source: retrySource,
		runMeta: { datasetName: datasetNameOverride, rewriteDomain: shouldRewriteDomain }
	});

	const sourceLabel = `${sourceCfg.env} (${sourceCfg.instance})`;
	const targetLabel = `${targetCfg.env} (${targetCfg.instance})`;
	const sourceDomain = `${sourceCfg.instance}.domo.com`;
	const targetDomain = `${targetCfg.instance}.domo.com`;

	console.log('Transfer Stream');
	console.log('===============');
	console.log(`Source:   ${sourceLabel}`);
	console.log(`Target:   ${targetLabel}`);
	console.log(`Streams:  ${streamIds.length}`);
	console.log(`Mapping:  ${mapping.file}`);
	if (dryRun) console.log('Dry run:  yes (no POST, no prompts, mapping not saved)');
	else if (noPrompt) console.log('Prompts:  disabled (unmapped accounts fail; map them, then --retry-errors)');
	if (shouldRewriteDomain) console.log(`Rewrite:  ${sourceDomain} → ${targetDomain}`);
	console.log();

	if (retrySource) {
		printSource(retrySource);
		if (streamIds.length === 0) {
			console.log('The source log has nothing left to retry.');
			process.exit(0);
		}
		if (!(await confirmSource(`Retry transferring ${streamIds.length} stream(s)? (yes/no): `, argv))) {
			console.log('Cancelled.');
			process.exit(0);
		}
	}
	logger.beginExecution(
		streamIds.map((sourceStreamId) => ({ sourceStreamId })),
		(entry) => String(entry.sourceStreamId)
	);

	let createdCount = 0;
	let skippedCount = 0;
	let errorCount = 0;

	for (let i = 0; i < streamIds.length; i++) {
		const sourceStreamId = streamIds[i];
		console.log(`[${i + 1}/${streamIds.length}] Stream ${sourceStreamId}`);

		// The create may have succeeded before the failure that put this stream in the retry set.
		const existingTargetId = retrySource ? idMapping.translate(mapping, 'streams', sourceStreamId) : null;
		if (existingTargetId != null) {
			console.log(`  Skipped: already transferred as stream ${existingTargetId} (per ${mapping.file})`);
			logger.addResult({
				sourceStreamId,
				targetStreamId: existingTargetId,
				status: 'skipped',
				reason: 'already-transferred'
			});
			skippedCount++;
			continue;
		}

		try {
			const source = await sourceApi.get(`/data/v1/streams/${sourceStreamId}?fields=all`);
			const sourceDatasetId = source.dataSource && source.dataSource.id;
			const sourceDatasetName = source.dataSource && source.dataSource.name;
			console.log(`  Source dataset: ${sourceDatasetName} (${sourceDatasetId})`);

			let body;
			let rewriteCount = 0;
			try {
				body = await buildCreateBody(source, mapping, {
					datasetNameOverride,
					allowPrompt,
					sourceLabel,
					targetLabel
				});
				if (shouldRewriteDomain) {
					const rewritten = rewriteDomain(body, sourceDomain, targetDomain);
					body = rewritten.value;
					rewriteCount = rewritten.count;
					if (rewriteCount > 0) {
						console.log(`  Rewrote ${rewriteCount} domain occurrence(s): ${sourceDomain} → ${targetDomain}`);
					}
				}
			} catch (err) {
				if (err.code === 'MISSING_ACCOUNT_MAPPING') {
					console.error(`  ✗ ${err.message}`);
					logger.addResult({
						sourceStreamId,
						status: 'error',
						reason: 'missing-account-mapping',
						error: err.message,
						sourceAccountId: source.account && source.account.id
					});
					if (debugMode) logger.writeDebugLog(sourceStreamId, { source, error: err.message });
					errorCount++;
					continue;
				}
				throw err;
			}

			if (dryRun) {
				console.log('  Dry run: would POST to /data/v1/streams');
				logger.addResult({
					sourceStreamId,
					status: 'dry-run',
					targetDatasetName: body.dataSource.name,
					domainRewrites: rewriteCount
				});
				if (debugMode) logger.writeDebugLog(sourceStreamId, { source, body, rewriteCount });
				continue;
			}

			const newStream = await targetApi.post('/data/v1/streams', body);
			const newDatasetId = newStream.dataSource && newStream.dataSource.id;
			console.log(`  ✓ Created stream ${newStream.id} → ${targetCfg.instanceUrl}/datasources/${newDatasetId}/details/overview`);

			idMapping.recordMapping(mapping, 'streams', {
				name: sourceDatasetName || `Stream ${sourceStreamId}`,
				oldId: source.id,
				newId: newStream.id
			});
			idMapping.recordMapping(mapping, 'datasets', {
				name: sourceDatasetName || `Dataset for stream ${sourceStreamId}`,
				oldId: sourceDatasetId,
				newId: newDatasetId
			});
			// Saved per stream so an interrupted run still records what it created.
			idMapping.saveMapping(mapping);

			logger.addResult({
				sourceStreamId,
				targetStreamId: newStream.id,
				sourceDatasetId,
				targetDatasetId: newDatasetId,
				datasetName: body.dataSource.name,
				domainRewrites: rewriteCount,
				status: 'created'
			});
			if (debugMode) logger.writeDebugLog(sourceStreamId, { source, body, newStream, rewriteCount });
			createdCount++;
		} catch (err) {
			console.error(`  ✗ ${err.message}`);
			logger.addResult({
				sourceStreamId,
				status: 'error',
				error: err.message
			});
			errorCount++;
		}

		if (i < streamIds.length - 1) {
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	if (!dryRun && createdCount > 0) {
		console.log(`\nMapping saved to ${mapping.file}`);
	}

	const summary = {
		total: streamIds.length,
		created: createdCount,
		skipped: skippedCount,
		errors: errorCount
	};
	console.log('\n=== Summary ===');
	console.log(`Total:    ${summary.total}`);
	console.log(`Created:  ${summary.created}`);
	console.log(`Skipped:  ${summary.skipped}`);
	console.log(`Errors:   ${summary.errors}`);

	logger.writeRunLog(summary);

	if (errorCount > 0) {
		if (!dryRun) {
			console.error(
				`\nSome streams failed. Run "node cli.js ${COMMAND} --source-env ${sourceEnv} --target-env ${targetEnv} --retry-errors" to retry them.`
			);
		}
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
