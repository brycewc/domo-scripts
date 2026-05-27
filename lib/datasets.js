/**
 * Dataset helpers shared across commands.
 */

// /data/v3/datasources/bulk rejects payloads larger than 100 ids.
const BULK_LOOKUP_LIMIT = 100;

/**
 * Partition dataset IDs into those that exist in the instance and those that
 * don't, using the bulk lookup endpoint (POST /data/v3/datasources/bulk).
 * Domo returns 400 "Request payload includes invalid ids" when a share/unshare
 * batch contains a nonexistent ID, so pre-filtering with this avoids poisoning
 * whole batches.
 *
 * IDs are deduped (first-seen order preserved) before lookup; the returned
 * arrays contain unique IDs.
 *
 * @param {object} apiClient - an api client exposing post(path, body) (the lib/api
 *                             singleton or a createApiClient result)
 * @param {Array<string|number>} ids - dataset IDs to check
 * @param {object} [opts]
 * @param {number} [opts.delayMs=150] - delay between lookup chunks
 * @param {(chunkNumber:number, totalChunks:number, validInChunk:number)=>void} [opts.onProgress]
 * @returns {Promise<{ valid: string[], invalid: string[] }>}
 */
async function partitionExistingDatasets(apiClient, ids, opts = {}) {
	const delayMs = opts.delayMs != null ? opts.delayMs : 150;
	const onProgress = opts.onProgress;

	const seen = new Set();
	const unique = [];
	for (const raw of ids) {
		const id = String(raw);
		if (!seen.has(id)) {
			seen.add(id);
			unique.push(id);
		}
	}

	const existing = new Set();
	const totalChunks = Math.ceil(unique.length / BULK_LOOKUP_LIMIT);
	for (let start = 0; start < unique.length; start += BULK_LOOKUP_LIMIT) {
		const chunk = unique.slice(start, start + BULK_LOOKUP_LIMIT);
		const chunkNumber = Math.floor(start / BULK_LOOKUP_LIMIT) + 1;
		const resp = await apiClient.post('/data/v3/datasources/bulk', chunk);
		const got = (resp && resp.dataSources) || [];
		for (const ds of got) existing.add(String(ds.id));
		if (onProgress) onProgress(chunkNumber, totalChunks, got.length);
		if (start + BULK_LOOKUP_LIMIT < unique.length) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	const valid = unique.filter((id) => existing.has(id));
	const invalid = unique.filter((id) => !existing.has(id));
	return { valid, invalid };
}

module.exports = { partitionExistingDatasets };
