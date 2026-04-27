#!/usr/bin/env node
/**
 * Print full details for one operation from the bundled Domo OpenAPI spec.
 *
 * Usage:
 *   node scripts/describe-api.js --op listStreams
 *   node scripts/describe-api.js --path "/data/v1/streams" --method GET
 *   node scripts/describe-api.js --op listStreams --json
 *   node scripts/describe-api.js --op listStreams --full     # include full schemas (can be huge)
 *
 * Without --full, schemas are summarized to top-level keys + examples to keep output readable.
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
			if (parsed.openapi || parsed.swagger) return parsed;
			if (typeof parsed.output === 'string') return JSON.parse(parsed.output);
		}
	}
	throw new Error('openapi.json not found next to this script or in cwd');
}

function parseArgs(argv) {
	const args = { json: false, full: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--op') args.op = argv[++i];
		else if (a === '--path') args.path = argv[++i];
		else if (a === '--method') args.method = argv[++i].toLowerCase();
		else if (a === '--json') args.json = true;
		else if (a === '--full') args.full = true;
		else if (a === '--help' || a === '-h') args.help = true;
	}
	return args;
}

function findOp(spec, args) {
	for (const [p, methods] of Object.entries(spec.paths || {})) {
		for (const [m, op] of Object.entries(methods)) {
			if (m === 'parameters' || m.startsWith('x-')) continue;
			if (args.op && op.operationId === args.op) {
				return { path: p, method: m.toUpperCase(), op };
			}
			if (args.path && p === args.path && (!args.method || m === args.method)) {
				return { path: p, method: m.toUpperCase(), op };
			}
		}
	}
	// If --op was a substring (no exact match), fall back to first prefix match
	if (args.op) {
		const lc = args.op.toLowerCase();
		for (const [p, methods] of Object.entries(spec.paths || {})) {
			for (const [m, op] of Object.entries(methods)) {
				if (m === 'parameters' || m.startsWith('x-')) continue;
				if ((op.operationId || '').toLowerCase().includes(lc)) {
					return { path: p, method: m.toUpperCase(), op };
				}
			}
		}
	}
	return null;
}

function summarizeSchema(schema, depth = 0) {
	if (!schema || typeof schema !== 'object') return schema;
	if (Array.isArray(schema)) return schema.map((s) => summarizeSchema(s, depth + 1));
	const out = {};
	if (schema.type) out.type = schema.type;
	if (schema.format) out.format = schema.format;
	if (schema.enum) out.enum = schema.enum;
	if (schema.example !== undefined) out.example = schema.example;
	if (schema.nullable) out.nullable = true;
	if (schema.required) out.required = schema.required;
	if (schema.items) out.items = depth >= 1 ? '…' : summarizeSchema(schema.items, depth + 1);
	if (schema.properties) {
		if (depth >= 1) {
			out.properties = `{${Object.keys(schema.properties).join(', ')}}`;
		} else {
			out.properties = {};
			for (const [k, v] of Object.entries(schema.properties)) {
				out.properties[k] = summarizeSchema(v, depth + 1);
			}
		}
	}
	return out;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || (!args.op && !args.path)) {
		console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
		process.exit(args.help ? 0 : 1);
	}

	const spec = loadSpec();
	const found = findOp(spec, args);
	if (!found) {
		console.error('No matching operation found.');
		process.exit(1);
	}

	const { method, op } = found;
	const opPath = found.path;

	if (args.json) {
		console.log(JSON.stringify({ method, path: opPath, ...op }, null, 2));
		return;
	}

	console.log(`${method} ${opPath}`);
	if (op.operationId) console.log(`operationId: ${op.operationId}`);
	if (op.tags?.length) console.log(`tags:        ${op.tags.join(', ')}`);
	if (op.summary) console.log(`summary:     ${op.summary}`);
	if (op.description && op.description !== op.summary) {
		console.log(`\ndescription:\n${op.description}`);
	}

	if (op.parameters?.length) {
		console.log('\nparameters:');
		for (const p of op.parameters) {
			const req = p.required ? ' (required)' : '';
			const ex = p.schema?.example !== undefined ? ` e.g. ${JSON.stringify(p.schema.example)}` : '';
			console.log(`  - ${p.name} (${p.in}${req})${ex}`);
			if (p.description) console.log(`      ${p.description}`);
		}
	}

	if (op.requestBody) {
		console.log('\nrequest body:');
		const content = op.requestBody.content || {};
		for (const [media, ct] of Object.entries(content)) {
			console.log(`  ${media}:`);
			const schema = args.full ? ct.schema : summarizeSchema(ct.schema);
			console.log(JSON.stringify(schema, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
			if (ct.example) {
				console.log('  example:');
				console.log(JSON.stringify(ct.example, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
			}
		}
	}

	if (op.responses) {
		console.log('\nresponses:');
		for (const [status, resp] of Object.entries(op.responses)) {
			console.log(`  ${status}: ${resp.description || ''}`);
			const content = resp.content || {};
			for (const [media, ct] of Object.entries(content)) {
				const schema = args.full ? ct.schema : summarizeSchema(ct.schema);
				const out = JSON.stringify(schema, null, 2);
				if (out) {
					console.log(`    ${media}:`);
					console.log(out.split('\n').map((l) => '      ' + l).join('\n'));
				}
			}
		}
	}

	if (!args.full) {
		console.log('\n(Schemas summarized — pass --full for raw schema, or --json for everything.)');
	}
}

main();
