const fs = require('fs');
const path = require('path');

const MAPPINGS_DIR = path.join(__dirname, '..', 'id-mappings');
const KINDS = ['accounts', 'providers', 'users', 'streams', 'datasets', 'dataflows'];

function pathFor(sourceEnv, targetEnv) {
	return path.join(MAPPINGS_DIR, `${sourceEnv}_to_${targetEnv}.json`);
}

function emptyData() {
	return Object.fromEntries(KINDS.map((k) => [k, []]));
}

function loadMapping(sourceEnv, targetEnv) {
	if (!sourceEnv || !targetEnv) {
		throw new Error('loadMapping requires sourceEnv and targetEnv');
	}
	const file = pathFor(sourceEnv, targetEnv);
	const data = emptyData();
	if (fs.existsSync(file)) {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		for (const k of KINDS) {
			if (Array.isArray(parsed[k])) data[k] = parsed[k];
		}
	}
	return { sourceEnv, targetEnv, file, data };
}

function translate(mapping, kind, oldId) {
	if (oldId == null) return null;
	const arr = mapping.data[kind];
	if (!arr) return null;
	const hit = arr.find((e) => String(e.oldId) === String(oldId));
	return hit ? hit.newId : null;
}

function recordMapping(mapping, kind, entry) {
	if (!KINDS.includes(kind)) throw new Error(`Unknown mapping kind: ${kind}`);
	const arr = mapping.data[kind];
	const i = arr.findIndex((e) => String(e.oldId) === String(entry.oldId));
	if (i >= 0) arr[i] = entry;
	else arr.push(entry);
}

function saveMapping(mapping) {
	fs.mkdirSync(MAPPINGS_DIR, { recursive: true });
	fs.writeFileSync(mapping.file, JSON.stringify(mapping.data, null, 2));
}

function singularize(kind) {
	return kind.endsWith('s') ? kind.slice(0, -1) : kind;
}

async function defaultPrompt(question) {
	const readline = require('readline/promises');
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(question);
		return answer.trim();
	} finally {
		rl.close();
	}
}

/**
 * Resolve an ID via the mapping; if it's not present, prompt the user for the
 * target-instance equivalent and persist the new entry. Returns the new ID,
 * or `null` if the user skipped (blank input). Throws if stdin is not a TTY
 * and the default prompt would have been used.
 *
 * @param {object} mapping - From loadMapping(sourceEnv, targetEnv)
 * @param {string} kind    - One of KINDS (e.g. 'accounts')
 * @param {string|number} oldId - Source-instance ID
 * @param {object} [options]
 * @param {string} [options.name] - Human-readable label included in the prompt
 * @param {string} [options.sourceLabel] - e.g. "prod (acme-prod)"
 * @param {string} [options.targetLabel] - e.g. "sandbox (acme-sandbox)"
 * @param {function} [options.promptFn] - Override for testing
 * @param {boolean} [options.save=true] - Save mapping to disk after a new entry
 */
async function resolveOrPrompt(mapping, kind, oldId, options = {}) {
	if (oldId == null) return null;
	if (!KINDS.includes(kind)) throw new Error(`Unknown mapping kind: ${kind}`);

	const existing = translate(mapping, kind, oldId);
	if (existing != null) return existing;

	const { name = null, sourceLabel, targetLabel, promptFn = defaultPrompt, save = true } = options;

	if (promptFn === defaultPrompt && !process.stdin.isTTY) {
		throw new Error(
			`No mapping for ${singularize(kind)} oldId=${oldId}${name ? ` (${name})` : ''} ` +
				`in ${mapping.file} and stdin is not a TTY — cannot prompt. ` +
				`Add the entry manually or run interactively.`
		);
	}

	const namePart = name ? ` "${name}"` : '';
	const sourcePart = sourceLabel ? ` from ${sourceLabel}` : '';
	const targetPart = targetLabel ? ` on ${targetLabel}` : '';
	const question =
		`\nNo mapping for ${singularize(kind)} ${oldId}${namePart}${sourcePart}.\n` +
		`Enter the corresponding ID${targetPart} (blank to skip): `;

	const answer = await promptFn(question);
	if (!answer) return null;

	recordMapping(mapping, kind, { name, oldId, newId: answer });
	if (save) saveMapping(mapping);
	return answer;
}

module.exports = {
	loadMapping,
	translate,
	recordMapping,
	saveMapping,
	resolveOrPrompt,
	KINDS
};
