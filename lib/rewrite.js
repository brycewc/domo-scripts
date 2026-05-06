/**
 * Recursively replace every occurrence of `source` with `target` in any string
 * found inside `value`. Walks arrays and plain objects; primitives that aren't
 * strings are returned unchanged.
 *
 * JSON-encoded strings (like Domo's `configuration[].value` blobs) are treated
 * as ordinary strings — a literal substring replace inside the encoded form
 * produces the same valid JSON, since hostnames don't contain any characters
 * that JSON has to escape.
 *
 * Returns `{ value, count }` — `count` is the number of literal substring
 * replacements performed across the entire walk.
 */
function rewriteDomain(value, source, target) {
	if (!source || !target) throw new Error('rewriteDomain: source and target are required');
	if (source === target) return { value, count: 0 };

	let count = 0;

	function walk(v) {
		if (typeof v === 'string') {
			const occurrences = v.split(source).length - 1;
			if (occurrences === 0) return v;
			count += occurrences;
			return v.split(source).join(target);
		}
		if (Array.isArray(v)) return v.map(walk);
		if (v !== null && typeof v === 'object') {
			const out = {};
			for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
			return out;
		}
		return v;
	}

	return { value: walk(value), count };
}

module.exports = { rewriteDomain };
