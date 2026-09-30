/**
 * Revoke (delete) Domo developer access tokens in bulk.
 *
 * Pick one source for the token list:
 *   --id                Single token ID (enables debug logging)
 *   --ids               Comma-separated token IDs
 *   --file              CSV with token IDs (default column: "Token ID")
 *   --owner             User ID — fetches all tokens and revokes those owned by that user
 *   --expired           Fetches all tokens and revokes those whose expiry is in the past
 *   --deleted-owners    Fetches all tokens and revokes those whose owner has been deleted
 *
 * Usage:
 *   node cli.js bulk-revoke-access-tokens --id 42
 *   node cli.js bulk-revoke-access-tokens --ids "42,43,44"
 *   node cli.js bulk-revoke-access-tokens --file "tokens.csv"
 *   node cli.js bulk-revoke-access-tokens --file "tokens.csv" --column "id"
 *   node cli.js bulk-revoke-access-tokens --owner 1250228141
 *   node cli.js bulk-revoke-access-tokens --expired
 *   node cli.js bulk-revoke-access-tokens --deleted-owners --dry-run
 *   node cli.js bulk-revoke-access-tokens --from-dry-run
 *   node cli.js bulk-revoke-access-tokens --retry-errors
 *
 * Options:
 *   --id              Single token ID (enables debug logging)
 *   --ids             Comma-separated token IDs
 *   --file, -f        CSV with token IDs
 *   --column, -c      CSV column with token IDs (default: "Token ID")
 *   --filter-column   CSV column to filter on
 *   --filter-value    Required value for --filter-column
 *   --owner           Revoke every token owned by this user ID
 *   --expired         Revoke every token whose expiry is in the past
 *   --deleted-owners  Revoke every token whose owner has been deleted
 *   --dry-run         Preview without revoking
 *   --from-dry-run [file]  Revoke exactly the tokens a dry run listed (default: latest dry run)
 *   --retry-errors [file]  Retry the failed and unreached revokes of a run (default: latest run)
 *   --max-age <hours>      Allow a source log older than 24 hours
 *   --yes, -y              Skip the confirmation prompt for the two flags above
 */

const { api, config, resolveIds, createLogger, loadSource, printSource, confirmSource, showHelp } = require('../lib');
const argv = require('minimist')(process.argv.slice(2));

const COMMAND = 'bulk-revoke-access-tokens';
const USER_INDEX_BATCH_SIZE = 50;
const SELECTION_FLAGS = [
	'id',
	'ids',
	'file',
	'f',
	'column',
	'c',
	'filter-column',
	'filter-value',
	'owner',
	'expired',
	'deleted-owners',
	'dry-run',
	'dry'
];

const HELP_TEXT = `Usage: node cli.js bulk-revoke-access-tokens [options]

Revoke (delete) Domo developer access tokens in bulk.

Token source (one of):
  --id <id>              Single token ID (enables debug logging)
  --ids <a,b,c>          Comma-separated token IDs
  --file, -f <path>      CSV with token IDs
  --owner <userId>       Revoke every token owned by this user ID
  --expired              Revoke every token whose expiry is in the past
  --deleted-owners       Revoke every token whose owner has been deleted

Optional:
  --column, -c <name>    CSV column with token IDs (default: "Token ID")
  --filter-column <col>  Filter input CSV rows by column
  --filter-value <val>   Required value for --filter-column
  --dry-run              Preview without revoking
  --help                 Show this help

Reusing an earlier run (tokens already gone are skipped):
  --from-dry-run [file]  Revoke exactly the tokens a dry run listed (default: the latest dry run log)
  --retry-errors [file]  Retry the failed and unreached revokes of a run (default: the latest run log)
  --max-age <hours>      Allow a source log older than 24 hours
  --yes, -y              Skip the confirmation prompt`;

async function fetchAllAccessTokens() {
	const tokens = await api.get('/data/v1/accesstokens');
	return Array.isArray(tokens) ? tokens : [];
}

async function fetchUserIndexBatch(ids) {
	config.requireAuth();
	const url = `${config.instanceUrl}/users/index?cvUserIds=${ids.join(',')}`;
	const res = await fetch(url, {
		headers: {
			'X-DOMO-Developer-Token': config.accessToken,
			Accept: 'application/json'
		}
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GET /users/index failed: HTTP ${res.status}: ${text}`);
	}
	const text = await res.text();
	const data = text ? JSON.parse(text) : [];
	return Array.isArray(data) ? data : [];
}

async function findDeletedOwners(tokens) {
	const uniqueOwnerIds = [
		...new Set(
			tokens
				.map((t) => t.ownerId)
				.filter((id) => id != null)
				.map(String)
		)
	];
	const totalBatches = Math.ceil(uniqueOwnerIds.length / USER_INDEX_BATCH_SIZE);
	console.log(
		`  Checking ${uniqueOwnerIds.length} unique owner(s) in ${totalBatches} batch(es) of ${USER_INDEX_BATCH_SIZE}...`
	);

	const deleted = new Map();
	for (let start = 0; start < uniqueOwnerIds.length; start += USER_INDEX_BATCH_SIZE) {
		const batch = uniqueOwnerIds.slice(start, start + USER_INDEX_BATCH_SIZE);
		let users;
		try {
			users = await fetchUserIndexBatch(batch);
		} catch (err) {
			console.error(`    ✗ Batch ${start / USER_INDEX_BATCH_SIZE + 1} failed: ${err.message}`);
			continue;
		}

		for (const user of users) {
			if (user && user.userActive === false && user.id != null) {
				deleted.set(String(user.id), user.displayName || null);
			}
		}

		if (start + USER_INDEX_BATCH_SIZE < uniqueOwnerIds.length) {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	console.log(`  Found ${deleted.size} deleted owner(s)`);
	return deleted;
}

function describeToken(token) {
	const parts = [`id=${token.id}`];
	if (token.name) parts.push(`name="${token.name}"`);
	if (token.ownerId != null) {
		parts.push(`owner=${token.ownerName || token.ownerEmail || token.ownerId}`);
	}
	if (token.expires != null) {
		parts.push(`expires=${new Date(token.expires).toISOString()}`);
	}
	return parts.join(' ');
}

function tokenEntry(id, token) {
	return {
		id: String(id),
		name: token ? token.name || null : null,
		ownerId: token ? (token.ownerId ?? null) : null,
		expires: token ? (token.expires ?? null) : null
	};
}

// Drops tokens that are no longer present so a stale plan never re-deletes an id.
async function loadFromSource(source) {
	const live = new Map((await fetchAllAccessTokens()).map((t) => [String(t.id), t]));
	const tokenById = {};
	const tokenIds = [];
	const missing = [];
	for (const entry of source.entries) {
		const token = live.get(entry.id);
		if (token) {
			tokenIds.push(entry.id);
			tokenById[entry.id] = token;
		} else {
			missing.push(entry);
		}
	}
	return { tokenIds, tokenById, missing };
}

async function discoverTokens(owner, expiredOnly, deletedOwnersOnly) {
	const fetchModes = [owner && '--owner', expiredOnly && '--expired', deletedOwnersOnly && '--deleted-owners'].filter(Boolean);
	if (fetchModes.length > 1) {
		throw new Error(`Cannot combine ${fetchModes.join(' and ')}`);
	}

	const fetchSource = fetchModes.length === 1;
	const idSource = argv.id || argv.ids || argv.file || argv.f;

	if (fetchSource && idSource) {
		throw new Error(
			'Use either --owner / --expired / --deleted-owners (fetch mode) OR --id / --ids / --file (list mode), not both'
		);
	}
	if (!fetchSource && !idSource) {
		throw new Error(
			'One of --id, --ids, --file, --owner, --expired, or --deleted-owners is required'
		);
	}

	let tokenIds;
	let debugMode = false;
	let tokenById = {};
	let source;

	if (fetchSource) {
		source = owner ? `owner=${owner}` : expiredOnly ? 'expired' : 'deleted-owners';
		console.log(`Fetching all access tokens to filter by ${source}...`);
		const all = await fetchAllAccessTokens();
		console.log(`  Retrieved ${all.length} token(s)`);

		let matches;
		if (owner) {
			matches = all.filter((t) => String(t.ownerId) === owner);
		} else if (expiredOnly) {
			const now = Date.now();
			matches = all.filter((t) => typeof t.expires === 'number' && t.expires < now);
		} else {
			const deletedOwners = await findDeletedOwners(all);
			matches = all.filter(
				(t) => t.ownerId != null && deletedOwners.has(String(t.ownerId))
			);
			// /users/index gives a usable displayName; the access-token record's
			// ownerName is often null for deleted users, so backfill it.
			for (const t of matches) {
				const displayName = deletedOwners.get(String(t.ownerId));
				if (displayName && !t.ownerName) t.ownerName = displayName;
			}
		}
		console.log('');

		tokenIds = matches.map((t) => String(t.id));
		for (const t of matches) tokenById[String(t.id)] = t;
	} else {
		const resolved = resolveIds(argv, {
			idFlag: 'id',
			idsFlag: 'ids',
			columnDefault: 'Token ID'
		});
		tokenIds = resolved.ids;
		debugMode = resolved.debugMode;
		source = argv.id
			? `id=${argv.id}`
			: argv.ids
				? `ids=${argv.ids}`
				: `file=${argv.file || argv.f}`;
	}

	return { tokenIds, tokenById, debugMode, sourceLabel: source };
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const planSource = loadSource(COMMAND, argv, {
		selectionFlags: SELECTION_FLAGS,
		toEntries: (row) => (row.id == null ? null : tokenEntry(row.id, row))
	});
	const meta = planSource ? planSource.meta : null;
	const dryRun = argv['dry-run'] || argv.dry || false;
	const owner = meta ? meta.owner : argv.owner != null ? String(argv.owner) : null;
	const expiredOnly = meta ? Boolean(meta.expiredOnly) : Boolean(argv.expired);
	const deletedOwnersOnly = meta ? Boolean(meta.deletedOwnersOnly) : Boolean(argv['deleted-owners']);

	let tokenIds;
	let tokenById;
	let debugMode = false;
	let sourceLabel;
	let missing = [];
	if (planSource) {
		sourceLabel = meta.source;
		console.log('Fetching all access tokens to check which logged tokens still exist...');
		({ tokenIds, tokenById, missing } = await loadFromSource(planSource));
		console.log('');
	} else {
		({ tokenIds, tokenById, debugMode, sourceLabel } = await discoverTokens(owner, expiredOnly, deletedOwnersOnly));
	}

	const logger = createLogger(COMMAND, {
		debugMode,
		dryRun,
		source: planSource,
		runMeta: {
			source: sourceLabel,
			owner: owner || null,
			expiredOnly,
			deletedOwnersOnly,
			file: meta ? meta.file : argv.file || argv.f || null,
			column: meta ? meta.column : argv.column || argv.c || 'Token ID',
			total: tokenIds.length + missing.length
		}
	});

	console.log('Bulk Revoke Access Tokens');
	console.log('=========================\n');
	if (dryRun) console.log('*** DRY RUN: no tokens will be revoked ***\n');
	if (planSource) printSource(planSource);
	console.log(`Source: ${sourceLabel}`);
	console.log(`Tokens: ${tokenIds.length}\n`);

	for (const entry of missing) {
		console.log(`  ↷ id=${entry.id} no longer exists (skipped)`);
		logger.addResult({ ...entry, status: 'skipped', reason: 'not-found', error: null });
	}
	if (missing.length > 0) console.log('');

	if (tokenIds.length === 0) {
		console.log(planSource ? 'None of the logged tokens still exist. Nothing to do.' : 'No matching tokens found. Nothing to do.');
		logger.writeRunLog({ successCount: 0, skippedCount: missing.length, errorCount: 0 });
		return;
	}

	if (planSource) {
		const ok = await confirmSource(`Revoke ${tokenIds.length} access token(s)? (yes/no): `, argv);
		if (!ok) {
			console.log('Aborted. No changes were made.');
			process.exit(0);
		}
		console.log('');
	}

	logger.beginExecution(
		tokenIds.map((id) => tokenEntry(id, tokenById[id])),
		(row) => String(row.id)
	);

	let successCount = 0;
	let errorCount = 0;

	for (let i = 0; i < tokenIds.length; i++) {
		const id = tokenIds[i];
		const meta = tokenById[id];
		const label = meta ? describeToken(meta) : `id=${id}`;
		console.log(`[${i + 1}/${tokenIds.length}] ${label}`);

		const debugLog = debugMode
			? { id, token: meta || null, timestamp: new Date().toISOString() }
			: null;
		const entry = { ...tokenEntry(id, meta), status: null, error: null };

		try {
			if (dryRun) {
				console.log('  [DRY RUN] Would revoke');
				entry.status = 'dry-run';
			} else {
				await api.del(`/data/v1/accesstokens/${id}`);
				console.log('  ✓ Revoked');
				entry.status = 'revoked';
			}
			successCount++;
		} catch (error) {
			console.error(`  ✗ Error: ${error.message}`);
			entry.status = 'error';
			entry.error = error.message;
			if (debugLog) debugLog.error = error.message;
			errorCount++;
		}

		if (debugLog) logger.writeDebugLog(`token_${id}`, debugLog);
		logger.addResult(entry);

		if (i < tokenIds.length - 1) {
			await new Promise((r) => setTimeout(r, 150));
		}
	}

	console.log('\n=== Summary ===');
	console.log(`Total:     ${tokenIds.length + missing.length}`);
	console.log(`${dryRun ? 'Would revoke' : 'Revoked'}: ${successCount}`);
	if (planSource) console.log(`Gone:      ${missing.length}`);
	console.log(`Errors:    ${errorCount}`);

	logger.writeRunLog({ successCount, skippedCount: missing.length, errorCount });

	if (dryRun) {
		console.log(`\nRun "node cli.js ${COMMAND} --from-dry-run" to apply this plan.`);
	}
	if (errorCount > 0) {
		console.error(
			dryRun || debugMode
				? '\nSome tokens failed. Check the error messages above.'
				: `\nSome tokens failed. Run "node cli.js ${COMMAND} --retry-errors" to retry them.`
		);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
