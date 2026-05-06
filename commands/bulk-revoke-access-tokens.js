/**
 * Revoke (delete) Domo developer access tokens in bulk.
 *
 * Pick one source for the token list:
 *   --token-id          Single token ID (enables debug logging)
 *   --token-ids         Comma-separated token IDs
 *   --file              CSV with token IDs (default column: "Token ID")
 *   --owner             User ID — fetches all tokens and revokes those owned by that user
 *   --expired           Fetches all tokens and revokes those whose expiry is in the past
 *
 * Usage:
 *   node cli.js bulk-revoke-access-tokens --token-id 42
 *   node cli.js bulk-revoke-access-tokens --token-ids "42,43,44"
 *   node cli.js bulk-revoke-access-tokens --file "tokens.csv"
 *   node cli.js bulk-revoke-access-tokens --file "tokens.csv" --column "id"
 *   node cli.js bulk-revoke-access-tokens --owner 1250228141
 *   node cli.js bulk-revoke-access-tokens --expired
 *   node cli.js bulk-revoke-access-tokens --expired --dry-run
 *
 * Options:
 *   --token-id        Single token ID (enables debug logging)
 *   --token-ids       Comma-separated token IDs
 *   --file, -f        CSV with token IDs
 *   --column, -c      CSV column with token IDs (default: "Token ID")
 *   --filter-column   CSV column to filter on
 *   --filter-value    Required value for --filter-column
 *   --owner           Revoke every token owned by this user ID
 *   --expired         Revoke every token whose expiry is in the past
 *   --dry-run         Preview without revoking
 */

const api = require('../lib/api');
const { resolveIds } = require('../lib/input');
const { createLogger } = require('../lib/log');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-revoke-access-tokens [options]

Revoke (delete) Domo developer access tokens in bulk.

Token source (one of):
  --token-id <id>        Single token ID (enables debug logging)
  --token-ids <a,b,c>    Comma-separated token IDs
  --file, -f <path>      CSV with token IDs
  --owner <userId>       Revoke every token owned by this user ID
  --expired              Revoke every token whose expiry is in the past

Optional:
  --column, -c <name>    CSV column with token IDs (default: "Token ID")
  --filter-column <col>  Filter input CSV rows by column
  --filter-value <val>   Required value for --filter-column
  --dry-run              Preview without revoking
  --help                 Show this help`;

async function fetchAllAccessTokens() {
	const tokens = await api.get('/data/v1/accesstokens');
	return Array.isArray(tokens) ? tokens : [];
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

async function main() {
	showHelp(argv, HELP_TEXT);

	const dryRun = argv['dry-run'] || argv.dry || false;
	const owner = argv.owner != null ? String(argv.owner) : null;
	const expiredOnly = Boolean(argv.expired);

	if (owner && expiredOnly) {
		throw new Error('Cannot combine --owner and --expired');
	}

	const fetchSource = owner || expiredOnly;
	const idSource = argv['token-id'] || argv['token-ids'] || argv.file || argv.f;

	if (fetchSource && idSource) {
		throw new Error(
			'Use either --owner / --expired (fetch mode) OR --token-id / --token-ids / --file (list mode), not both'
		);
	}
	if (!fetchSource && !idSource) {
		throw new Error(
			'One of --token-id, --token-ids, --file, --owner, or --expired is required'
		);
	}

	let tokenIds;
	let debugMode = false;
	let tokenById = {};
	let source;

	if (fetchSource) {
		source = owner ? `owner=${owner}` : 'expired';
		console.log(`Fetching all access tokens to filter by ${source}...`);
		const all = await fetchAllAccessTokens();
		console.log(`  Retrieved ${all.length} token(s)\n`);

		const now = Date.now();
		const matches = owner
			? all.filter((t) => String(t.ownerId) === owner)
			: all.filter((t) => typeof t.expires === 'number' && t.expires < now);

		tokenIds = matches.map((t) => String(t.id));
		for (const t of matches) tokenById[String(t.id)] = t;
	} else {
		const resolved = resolveIds(argv, { name: 'token', columnDefault: 'Token ID' });
		tokenIds = resolved.ids;
		debugMode = resolved.debugMode;
		source = argv['token-id']
			? `token-id=${argv['token-id']}`
			: argv['token-ids']
				? `token-ids=${argv['token-ids']}`
				: `file=${argv.file || argv.f}`;
	}

	const logger = createLogger('revokeAccessTokens', {
		debugMode,
		dryRun,
		runMeta: {
			source,
			owner: owner || null,
			expiredOnly,
			file: argv.file || argv.f || null,
			column: argv.column || argv.c || 'Token ID',
			total: tokenIds.length
		}
	});

	console.log('Bulk Revoke Access Tokens');
	console.log('=========================\n');
	if (dryRun) console.log('*** DRY RUN — no tokens will be revoked ***\n');
	console.log(`Source: ${source}`);
	console.log(`Tokens: ${tokenIds.length}\n`);

	if (tokenIds.length === 0) {
		console.log('No matching tokens found. Nothing to do.');
		logger.writeRunLog({ successCount: 0, errorCount: 0 });
		return;
	}

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
		const entry = {
			id,
			name: meta ? meta.name || null : null,
			ownerId: meta ? meta.ownerId ?? null : null,
			expires: meta ? meta.expires ?? null : null,
			status: null,
			error: null
		};

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
	console.log(`Total:     ${tokenIds.length}`);
	console.log(`${dryRun ? 'Would revoke' : 'Revoked'}: ${successCount}`);
	console.log(`Errors:    ${errorCount}`);

	logger.writeRunLog({ successCount, errorCount });

	if (errorCount > 0) {
		console.error('\nSome tokens failed. Check the error messages above.');
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
