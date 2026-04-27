#!/usr/bin/env node
/**
 * Authenticated request against the Domo Product API.
 *
 * Usage:
 *   node scripts/call-api.js GET /data/v1/streams
 *   node scripts/call-api.js GET /data/v1/streams --query limit=5 --query offset=0
 *   node scripts/call-api.js PUT /data/v1/streams/123 --body '{"updateMethod":"APPEND"}'
 *   node scripts/call-api.js POST /data/v1/streams --body-file body.json
 *   node scripts/call-api.js DELETE /data/v3/datasources/abc-123
 *
 * Auth (required):
 *   DOMO_INSTANCE       Your Domo subdomain (the "foo" in https://foo.domo.com)
 *   DOMO_ACCESS_TOKEN   A developer token (Admin → Security → Access tokens)
 *
 * The script looks for a .env file in cwd and in the skill root and loads
 * KEY=value lines from it (no dependency on the dotenv package).
 *
 * Other flags:
 *   --base /api          Server prefix to use (default /api). Pass "" for root.
 *                        Most operations live under /api; a few use /apiapps or /apicontent.
 *   --header K:V         Add a custom header (repeatable).
 *   --raw                Print response body verbatim (no JSON pretty-print).
 *   --status             Also print HTTP status to stderr.
 *   --no-fail            Exit 0 even on non-2xx responses (still prints body).
 */

const fs = require('fs');
const path = require('path');

function loadDotenv() {
	const candidates = [
		path.join(process.cwd(), '.env'),
		path.join(__dirname, '..', '.env')
	];
	for (const p of candidates) {
		if (!fs.existsSync(p)) continue;
		const text = fs.readFileSync(p, 'utf8');
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const eq = trimmed.indexOf('=');
			if (eq === -1) continue;
			const key = trimmed.slice(0, eq).trim();
			let val = trimmed.slice(eq + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			if (!(key in process.env)) process.env[key] = val;
		}
	}
}

function parseArgs(argv) {
	const args = { headers: {}, query: [], base: '/api' };
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--body') args.body = argv[++i];
		else if (a === '--body-file') args.bodyFile = argv[++i];
		else if (a === '--query') args.query.push(argv[++i]);
		else if (a === '--header') {
			const h = argv[++i];
			const idx = h.indexOf(':');
			if (idx > -1) args.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
		} else if (a === '--base') args.base = argv[++i];
		else if (a === '--raw') args.raw = true;
		else if (a === '--status') args.status = true;
		else if (a === '--no-fail') args.noFail = true;
		else if (a === '--help' || a === '-h') args.help = true;
		else positional.push(a);
	}
	args.method = (positional[0] || '').toUpperCase();
	args.path = positional[1];
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.method || !args.path) {
		console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
		process.exit(args.help ? 0 : 1);
	}

	loadDotenv();
	const instance = process.env.DOMO_INSTANCE;
	const token = process.env.DOMO_ACCESS_TOKEN;

	if (!instance || !token) {
		console.error('Missing auth. Set DOMO_INSTANCE and DOMO_ACCESS_TOKEN in your environment');
		console.error('or in a .env file next to this script. Get a token from:');
		console.error(`  https://<instance>.domo.com  →  Admin → Security → Access tokens`);
		process.exit(2);
	}

	// Build URL: https://{instance}.domo.com{base}{path}
	// If the path already starts with /api/ or /apiapps/ etc, don't double-prefix.
	let urlPath = args.path;
	const knownPrefixes = ['/api', '/apiapps', '/apicontent'];
	const alreadyPrefixed = knownPrefixes.some(
		(pre) => urlPath === pre || urlPath.startsWith(pre + '/')
	);
	const base = alreadyPrefixed ? '' : args.base || '';
	let url = `https://${instance}.domo.com${base}${urlPath}`;

	if (args.query.length) {
		const qs = args.query
			.map((kv) => {
				const idx = kv.indexOf('=');
				if (idx === -1) return encodeURIComponent(kv);
				return `${encodeURIComponent(kv.slice(0, idx))}=${encodeURIComponent(kv.slice(idx + 1))}`;
			})
			.join('&');
		url += (url.includes('?') ? '&' : '?') + qs;
	}

	const headers = {
		'X-DOMO-Developer-Token': token,
		Accept: 'application/json',
		...args.headers
	};

	let body;
	if (args.bodyFile) {
		body = fs.readFileSync(args.bodyFile, 'utf8');
		if (!headers['Content-Type'] && !headers['content-type']) {
			headers['Content-Type'] = 'application/json';
		}
	} else if (args.body !== undefined) {
		body = args.body;
		if (!headers['Content-Type'] && !headers['content-type']) {
			headers['Content-Type'] = 'application/json';
		}
	}

	const response = await fetch(url, { method: args.method, headers, body });
	const text = await response.text();

	if (args.status) {
		console.error(`${args.method} ${url} → ${response.status} ${response.statusText}`);
	}

	if (args.raw || !text) {
		if (text) process.stdout.write(text);
	} else {
		try {
			console.log(JSON.stringify(JSON.parse(text), null, 2));
		} catch {
			process.stdout.write(text);
		}
	}

	if (!response.ok && !args.noFail) {
		if (!args.status) {
			console.error(`\n${args.method} ${url} → ${response.status} ${response.statusText}`);
		}
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
