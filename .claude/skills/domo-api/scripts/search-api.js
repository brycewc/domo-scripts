#!/usr/bin/env node
/**
 * Search the bundled Domo OpenAPI spec.
 *
 * Subcommands:
 *   tags                       List every tag with operation counts.
 *   tag <name>                 List operations under a tag (substring, case-insensitive).
 *   path <substring>           List operations whose path contains the substring.
 *   op <pattern>               List operations whose operationId contains the pattern.
 *   keyword <text>             Search summary + description + operationId.
 *
 * Common flags:
 *   --limit N                  Cap result count (default 50; use 0 for no cap).
 *   --json                     Emit JSON instead of human-readable lines.
 *
 * Examples:
 *   node scripts/search-api.js tags
 *   node scripts/search-api.js tag "DataSets and Streams"
 *   node scripts/search-api.js path "/streams"
 *   node scripts/search-api.js op listStreams
 *   node scripts/search-api.js keyword "transfer ownership"
 */

const path = require('path');
const fs = require('fs');

function loadSpec() {
	const candidates = [
		path.join(__dirname, '..', 'openapi.json'),
		path.join(process.cwd(), 'openapi.json')
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) {
			const raw = fs.readFileSync(p, 'utf8');
			const parsed = JSON.parse(raw);
			// Tolerate the wrapped-in-{output:"..."} form too
			if (parsed.openapi || parsed.swagger) return parsed;
			if (typeof parsed.output === 'string') return JSON.parse(parsed.output);
		}
	}
	throw new Error('openapi.json not found next to this script or in cwd');
}

function iterateOps(spec) {
	const ops = [];
	for (const [p, methods] of Object.entries(spec.paths || {})) {
		for (const [m, op] of Object.entries(methods)) {
			if (m === 'parameters' || m.startsWith('x-')) continue;
			ops.push({
				method: m.toUpperCase(),
				path: p,
				tags: op.tags || [],
				operationId: op.operationId || '',
				summary: op.summary || '',
				description: op.description || ''
			});
		}
	}
	return ops;
}

function parseArgs(argv) {
	const args = { positional: [], limit: 50, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--limit') args.limit = parseInt(argv[++i], 10);
		else if (a === '--json') args.json = true;
		else if (a === '--help' || a === '-h') args.help = true;
		else args.positional.push(a);
	}
	return args;
}

function format(op) {
	const id = op.operationId ? ` ${op.operationId}` : '';
	const summary = op.summary ? `  — ${op.summary}` : '';
	return `${op.method.padEnd(7)} ${op.path}${id}${summary}`;
}

function emit(results, args) {
	const capped = args.limit === 0 ? results : results.slice(0, args.limit);
	if (args.json) {
		console.log(JSON.stringify(capped, null, 2));
	} else {
		for (const op of capped) console.log(format(op));
		if (results.length > capped.length) {
			console.log(
				`\n… ${results.length - capped.length} more. Re-run with --limit 0 to see all, or narrow your search.`
			);
		} else {
			console.log(`\n${capped.length} result(s).`);
		}
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const [sub, ...rest] = args.positional;

	if (args.help || !sub) {
		console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
		process.exit(args.help ? 0 : 1);
	}

	const spec = loadSpec();
	const ops = iterateOps(spec);

	if (sub === 'tags') {
		const counts = {};
		for (const op of ops) {
			for (const t of op.tags.length ? op.tags : ['(untagged)']) {
				counts[t] = (counts[t] || 0) + 1;
			}
		}
		const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
		if (args.json) {
			console.log(JSON.stringify(Object.fromEntries(rows), null, 2));
		} else {
			for (const [t, c] of rows) console.log(`${String(c).padStart(5)}  ${t}`);
			console.log(`\n${rows.length} tag(s).`);
		}
		return;
	}

	const term = rest.join(' ').trim();
	if (!term) {
		console.error(`Subcommand "${sub}" requires a search term.`);
		process.exit(1);
	}
	const lc = term.toLowerCase();
	let results;

	if (sub === 'tag') {
		results = ops.filter((op) => op.tags.some((t) => t.toLowerCase().includes(lc)));
	} else if (sub === 'path') {
		results = ops.filter((op) => op.path.toLowerCase().includes(lc));
	} else if (sub === 'op') {
		results = ops.filter((op) => op.operationId.toLowerCase().includes(lc));
	} else if (sub === 'keyword') {
		results = ops.filter(
			(op) =>
				op.summary.toLowerCase().includes(lc) ||
				op.description.toLowerCase().includes(lc) ||
				op.operationId.toLowerCase().includes(lc)
		);
	} else {
		console.error(`Unknown subcommand: ${sub}. Try: tags | tag | path | op | keyword`);
		process.exit(1);
	}

	emit(results, args);
}

main();
