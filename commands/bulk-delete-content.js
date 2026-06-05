/**
 * Bulk delete mixed Domo content, routing each row to the right DELETE endpoint
 * by its object type. Designed to consume the CSV that bulk-list-user-content
 * emits (columns "Object Type" + "Object ID"), so the typical flow is:
 *
 *   bulk-list-user-content  →  join with usage  →  split used / unused  →
 *   bulk-transfer-ownership (used)  +  bulk-delete-content (unused)
 *
 * Supported types (native bulk endpoints used where they exist):
 *   dataflow     PUT    /dataprocessing/v1/dataflows/bulk/delete           (bulk)
 *   card         DELETE /content/v1/cards/bulk                             (bulk)
 *   dataset      POST   /data/v1/ui/bulk/delete                            (bulk)
 *   group        DELETE /content/v2/groups                                 (bulk)
 *   page         DELETE /content/v1/pages/{id}                             (per-item)
 *   app-studio   DELETE /content/v1/dataapps/{appId}                       (per-item)
 *   jupyter      DELETE /datascience/v1/workspaces/{id}                    (per-item)
 *   ai-project   DELETE /datascience/ml/v1/projects/{id}                   (per-item)
 *   workflow     DELETE /workflow/v1/models/{id}                           (per-item)
 *   project      DELETE /content/v1/projects/{id}                          (per-item)
 *   project-task DELETE /content/v1/projects/{projectId}/tasks/{id}        (per-item)
 *   collection   DELETE /datastores/v1/collections/{id}                    (per-item)
 *   account      DELETE /accounts/v1/accounts/{id}                         (per-item)
 *
 * project-task has no standalone delete endpoint — the parent projectId is
 * resolved first via GET /content/v1/tasks/{id}, then the task is deleted under
 * its project. jupyter is the activity-log DATA_SCIENCE_NOTEBOOK type (the API
 * calls these Jupyter workspaces).
 *
 * Users are intentionally NOT handled here — delete them with bulk-delete-users.
 *
 * WARNING: This is a destructive operation. Deleted content cannot be recovered.
 * Use --dry-run to preview which objects would be deleted before committing.
 *
 * Usage:
 *   # Mixed CSV straight from bulk-list-user-content (has an "Object Type" column)
 *   node cli.js bulk-delete-content --file "unused.csv" --dry-run
 *
 *   # Restrict a mixed CSV to only certain types
 *   node cli.js bulk-delete-content --file "unused.csv" --object-types "card,page"
 *
 *   # Single-type CSV with no type column
 *   node cli.js bulk-delete-content --file "cards.csv" --object-types "card"
 *
 *   # Ad-hoc list of IDs of one type
 *   node cli.js bulk-delete-content --object-types "dataflow" --ids "123,456"
 *   node cli.js bulk-delete-content --object-types "page" --id 789
 *
 * Options:
 *   --file, -f       CSV file with object IDs (and optionally a type column)
 *   --id, --ids      Single ID / comma-separated IDs (requires a single --object-types)
 *   --id-column      CSV column with object IDs (default: "Object ID")
 *   --type-column    CSV column with per-row object type (default: "Object Type")
 *   --object-types   Comma-separated canonical types. When the CSV has a type column,
 *                    this restricts deletion to the listed types. When there is no type
 *                    column (or for --id/--ids), it must be exactly one type and is
 *                    applied to every row.
 *   --batch-size     IDs per native bulk call for dataflow/card/dataset/group (default: 50)
 *   --concurrency    Parallel per-item deletes within a type (page, app-studio,
 *                    jupyter, ai-project, workflow, project, project-task,
 *                    collection, account) (default: 5). Types are still deleted
 *                    one at a time, in dependency order.
 *   --dry-run        Preview which objects would be deleted without deleting
 *
 * Types are deleted in a fixed dependency-safe order (card, page, app-studio,
 * jupyter, ai-project, workflow, project-task, project, dataset, dataflow,
 * account, collection, group) so dependents go before what they reference.
 * Deletes within a single type run concurrently; types do not overlap.
 */

const { api, readCSV, createLogger, showHelp } = require('../lib');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-delete-content [options]

WARNING: This is a destructive operation. Deleted content cannot be recovered.

Routes each row to the correct DELETE endpoint by object type. Consumes the CSV
that bulk-list-user-content emits ("Object Type" + "Object ID" columns).

Supported types: dataflow, card, dataset, group, page, app-studio, jupyter,
ai-project, workflow, project, project-task, collection, account.
(Users are not handled here — use bulk-delete-users.)

ID source:
  --file, -f       CSV file with object IDs (and optionally a type column)
  --id, --ids      Single ID / comma-separated IDs (requires a single --object-types)

Optional:
  --id-column      CSV column with object IDs (default: "Object ID")
  --type-column    CSV column with per-row object type (default: "Object Type")
  --object-types   Comma-separated canonical types. With a type column, restricts
                   deletion to those types. Without a type column (or for --id/--ids),
                   must be exactly one type and is applied to every row.
  --batch-size     IDs per native bulk call for dataflow/card/dataset/group (default: 50)
  --concurrency    Parallel per-item deletes within a type (default: 5)
  --dry-run        Preview without deleting

Types are deleted in a fixed dependency-safe order: card, page, app-studio,
jupyter, ai-project, workflow, project-task, project, dataset, dataflow,
account, collection, group. Deletes within a type run concurrently; types
never overlap.

Accepted type names (case-insensitive, '-' and '_' interchangeable). The
activity-log labels emitted by bulk-list-user-content are accepted too:
  dataflow     (DATAFLOW_TYPE)
  card         (CARD)
  dataset      (DATA_SOURCE)
  group        (GROUP)
  page         (PAGE)
  app-studio   (DATA_APP, data-app)
  jupyter      (DATA_SCIENCE_NOTEBOOK, jupyter-workspace)
  ai-project   (AI_PROJECT)
  workflow     (WORKFLOW_MODEL)
  project      (PROJECT)
  project-task (PROJECT_TASK)
  collection   (MAGNUM_COLLECTION, appdb-collection)
  account      (ACCOUNT)`;

// Canonical type → accepted aliases. Includes the activity-log labels that
// bulk-list-user-content writes into its "Object Type" column, normalized to
// lower-case with underscores → hyphens (see normalizeType).
const TYPE_ALIASES = {
	account: ['account'],
	'ai-project': ['ai-project'],
	'app-studio': ['app-studio', 'appstudio', 'data-app', 'dataapp'],
	card: ['card'],
	collection: ['collection', 'appdb-collection', 'magnum-collection'],
	dataflow: ['dataflow', 'dataflow-type'],
	dataset: ['dataset', 'datasource', 'data-source'],
	group: ['group'],
	jupyter: ['jupyter', 'jupyter-workspace', 'data-science-notebook'],
	page: ['page'],
	project: ['project'],
	'project-task': ['project-task'],
	workflow: ['workflow', 'workflow-model']
};

const ALIAS_TO_CANONICAL = {};
for (const [canonical, aliases] of Object.entries(TYPE_ALIASES)) {
	for (const alias of aliases) ALIAS_TO_CANONICAL[alias] = canonical;
}

// Deletion strategy per type. `bulk` (when present) takes an array of IDs and
// deletes them in one call; `single` deletes one ID. Bulk types fall back to
// `single` per ID when a batch fails, so one bad ID doesn't sink the batch.
const DELETERS = {
	dataflow: {
		label: 'dataflow',
		bulk: (ids) => api.put('/dataprocessing/v1/dataflows/bulk/delete', { dataFlowIds: ids.map((id) => Number(id)) }),
		single: (id) => api.del(`/dataprocessing/v1/dataflows/${id}`)
	},
	card: {
		label: 'card',
		bulk: (ids) => api.del(`/content/v1/cards/bulk?cardIds=${ids.map((id) => encodeURIComponent(id)).join(',')}`),
		single: (id) => api.del(`/content/v1/cards/bulk?cardIds=${encodeURIComponent(id)}`)
	},
	dataset: {
		label: 'dataset',
		bulk: (ids) => api.post('/data/v1/ui/bulk/delete', { ids, type: 'DATA_SOURCE' }),
		single: (id) => api.del(`/data/v3/datasources/${id}`)
	},
	group: {
		label: 'group',
		bulk: (ids) => api.del('/content/v2/groups', ids.map((id) => Number(id))),
		single: (id) => api.del(`/content/v2/groups/${id}`)
	},
	page: {
		label: 'page',
		single: (id) => api.del(`/content/v1/pages/${id}`)
	},
	'app-studio': {
		label: 'app studio app',
		single: (id) => api.del(`/content/v1/dataapps/${id}`)
	},
	jupyter: {
		label: 'Jupyter workspace',
		single: (id) => api.del(`/datascience/v1/workspaces/${id}`)
	},
	'ai-project': {
		label: 'AI project',
		single: (id) => api.del(`/datascience/ml/v1/projects/${id}`)
	},
	workflow: {
		label: 'workflow',
		single: (id) => api.del(`/workflow/v1/models/${id}`)
	},
	project: {
		label: 'project',
		single: (id) => api.del(`/content/v1/projects/${id}`)
	},
	'project-task': {
		// Tasks have no standalone delete endpoint (DELETE /content/v1/tasks/{id}
		// is 405). Resolve the parent projectId from the task, then delete it
		// scoped under its project.
		label: 'project task',
		single: async (id) => {
			const task = await api.get(`/content/v1/tasks/${id}`);
			const projectId = task && task.projectId;
			if (projectId == null) throw new Error(`could not resolve parent projectId for task ${id}`);
			return api.del(`/content/v1/projects/${projectId}/tasks/${id}`);
		}
	},
	collection: {
		label: 'AppDB collection',
		single: (id) => api.del(`/datastores/v1/collections/${id}`)
	},
	account: {
		label: 'account',
		single: (id) => api.del(`/accounts/v1/accounts/${id}`)
	}
};

// Order types are deleted in. This is dependency-safe, not cosmetic: dependents
// are removed before the things they reference (e.g. cards/pages/apps/notebooks
// before the datasets they sit on, datasets before the dataflows that produce
// them, project tasks before their parent project — which would otherwise take
// the tasks with it and 404 the per-task deletes), so we never orphan or block a
// downstream delete. Groups go last, since other content references them for
// access. Types are processed strictly in this order; only the deletes WITHIN a
// type may run concurrently.
const TYPE_ORDER = [
	'card',
	'page',
	'app-studio',
	'jupyter',
	'ai-project',
	'workflow',
	'project-task',
	'project',
	'dataset',
	'dataflow',
	'account',
	'collection',
	'group'
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Run `worker` over `items` with at most `limit` in flight at once, preserving
// nothing about order (callers that care order their types, not their items).
async function mapWithConcurrency(items, limit, worker) {
	let next = 0;
	const runOne = async () => {
		while (next < items.length) {
			const idx = next++;
			await worker(items[idx], idx);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

function normalizeType(raw) {
	if (raw == null) return null;
	const key = String(raw).trim().toLowerCase().replace(/_/g, '-');
	return ALIAS_TO_CANONICAL[key] || null;
}

function parseRequestedTypes() {
	if (!argv['object-types']) return null;
	return String(argv['object-types'])
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => {
			const canon = normalizeType(t);
			if (!canon) throw new Error(`Unknown object type: "${t}"`);
			return canon;
		});
}

// Build { canonicalType: [ids] } from --file or --id/--ids.
function buildObjectsByType(requestedTypes) {
	const objectsByType = {};
	const add = (type, id) => {
		if (!objectsByType[type]) objectsByType[type] = [];
		objectsByType[type].push(String(id));
	};

	const filePath = argv.file || argv.f;
	if (filePath) {
		const idColumn = argv['id-column'] || 'Object ID';
		const typeColumn = argv['type-column'] || 'Object Type';
		const records = readCSV(filePath);
		if (records.length === 0) throw new Error('CSV file has no rows');
		const columns = Object.keys(records[0]);
		if (!columns.includes(idColumn)) {
			throw new Error(`ID column "${idColumn}" not found in CSV. Available: ${columns.join(', ')}`);
		}
		const hasTypeColumn = columns.includes(typeColumn);
		if (!hasTypeColumn && (!requestedTypes || requestedTypes.length !== 1)) {
			throw new Error(
				`Type column "${typeColumn}" not found in CSV. Provide a CSV with that column, ` +
					`or pass exactly one --object-types to apply to every row. Available: ${columns.join(', ')}`
			);
		}

		let skipped = 0;
		for (const row of records) {
			const id = row[idColumn];
			if (!id) continue;
			let canon;
			if (hasTypeColumn) {
				canon = normalizeType(row[typeColumn]);
				if (!canon) {
					skipped++;
					continue;
				}
				if (requestedTypes && !requestedTypes.includes(canon)) continue;
			} else {
				canon = requestedTypes[0];
			}
			add(canon, id);
		}
		if (skipped > 0) {
			console.warn(`  Skipped ${skipped} row(s) with an unknown/unsupported "${typeColumn}" value.`);
		}
		return objectsByType;
	}

	// --id / --ids mode
	const raw = argv.id != null ? String(argv.id) : argv.ids != null ? String(argv.ids) : null;
	if (raw == null) {
		throw new Error('Provide --file, or --id/--ids with a single --object-types.');
	}
	if (!requestedTypes || requestedTypes.length !== 1) {
		throw new Error('--id/--ids require exactly one --object-types.');
	}
	for (const id of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
		add(requestedTypes[0], id);
	}
	return objectsByType;
}

async function deleteType(type, ids, { dryRun, batchSize, concurrency, logger }) {
	const deleter = DELETERS[type];
	console.log(`\n=== ${type} (${ids.length}) ===`);

	if (dryRun) {
		for (const id of ids) {
			console.log(`  [DRY RUN] Would delete ${deleter.label} ${id}`);
			logger.addResult({ objectType: type, objectId: id, status: 'dry-run' });
		}
		return { deleted: ids.length, errors: 0 };
	}

	let deleted = 0;
	let errors = 0;

	if (deleter.bulk) {
		const totalBatches = Math.ceil(ids.length / batchSize);
		for (let i = 0; i < ids.length; i += batchSize) {
			const chunk = ids.slice(i, i + batchSize);
			const batchNumber = Math.floor(i / batchSize) + 1;
			console.log(`  [${batchNumber}/${totalBatches}] Deleting ${chunk.length} ${deleter.label}(s)...`);
			try {
				await deleter.bulk(chunk);
				console.log(`    ✓ Batch ${batchNumber} succeeded`);
				for (const id of chunk) logger.addResult({ objectType: type, objectId: id, status: 'deleted', batch: batchNumber });
				deleted += chunk.length;
			} catch (error) {
				console.error(`    ✗ Batch ${batchNumber} failed: ${error.message}`);
				console.log(`    Retrying ${chunk.length} ${deleter.label}(s) individually...`);
				for (const id of chunk) {
					try {
						await deleter.single(id);
						console.log(`      ✓ ${deleter.label} ${id} deleted`);
						logger.addResult({ objectType: type, objectId: id, status: 'deleted', batch: batchNumber, retried: true });
						deleted++;
					} catch (singleError) {
						console.error(`      ✗ ${deleter.label} ${id} failed: ${singleError.message}`);
						logger.addResult({ objectType: type, objectId: id, status: 'error', error: singleError.message, batch: batchNumber });
						errors++;
					}
					await delay(150);
				}
			}
			if (i + batchSize < ids.length) await delay(150);
		}
	} else {
		// Per-item deletes for this type run concurrently (order within a type
		// doesn't matter; order across types does, and is enforced by the caller).
		let done = 0;
		await mapWithConcurrency(ids, concurrency, async (id) => {
			try {
				await deleter.single(id);
				logger.addResult({ objectType: type, objectId: id, status: 'deleted' });
				deleted++;
				console.log(`  ✓ [${++done}/${ids.length}] ${deleter.label} ${id} deleted`);
			} catch (error) {
				logger.addResult({ objectType: type, objectId: id, status: 'error', error: error.message });
				errors++;
				console.error(`  ✗ [${++done}/${ids.length}] ${deleter.label} ${id} failed: ${error.message}`);
			}
		});
	}

	return { deleted, errors };
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const dryRun = argv['dry-run'] || argv.dry || false;
	const batchSize = parseInt(argv['batch-size'] || argv.b || '50', 10);
	const concurrency = Math.max(1, parseInt(argv.concurrency || '5', 10));

	const requestedTypes = parseRequestedTypes();
	const objectsByType = buildObjectsByType(requestedTypes);

	const typesToProcess = TYPE_ORDER.filter((t) => objectsByType[t] && objectsByType[t].length > 0);
	const totalObjects = typesToProcess.reduce((n, t) => n + objectsByType[t].length, 0);

	if (totalObjects === 0) {
		console.log('No supported objects to delete.');
		process.exit(0);
	}

	const logger = createLogger('bulk-delete-content', {
		debugMode: false,
		dryRun,
		runMeta: {
			file: argv.file || argv.f || null,
			idColumn: argv['id-column'] || 'Object ID',
			typeColumn: argv['type-column'] || 'Object Type',
			requestedTypes: requestedTypes || 'all',
			batchSize,
			concurrency,
			countsByType: Object.fromEntries(typesToProcess.map((t) => [t, objectsByType[t].length]))
		}
	});

	console.log('Bulk Delete Content');
	console.log('===================\n');
	if (dryRun) console.log('*** DRY RUN — no content will be deleted ***\n');
	console.log(`Batch Size:  ${batchSize}`);
	console.log(`Concurrency: ${concurrency}`);
	console.log(`Objects:     ${totalObjects}`);
	for (const t of typesToProcess) console.log(`  ${t}: ${objectsByType[t].length}`);

	const summary = { totals: {}, deleted: 0, errors: 0 };
	for (const type of typesToProcess) {
		const { deleted, errors } = await deleteType(type, objectsByType[type], { dryRun, batchSize, concurrency, logger });
		summary.totals[type] = { deleted, errors };
		summary.deleted += deleted;
		summary.errors += errors;
	}

	const verb = dryRun ? 'would delete' : 'deleted';
	console.log('\n=== Summary ===');
	for (const type of typesToProcess) {
		const t = summary.totals[type];
		console.log(`  ${type}: ${t.deleted} ${verb}${t.errors ? `, ${t.errors} errors` : ''}`);
	}
	console.log(`Total ${verb}: ${summary.deleted}`);
	console.log(`Total errors:  ${summary.errors}`);

	logger.writeRunLog({ total: totalObjects, deleted: summary.deleted, errors: summary.errors, byType: summary.totals });

	if (dryRun) {
		console.log('\nRe-run without --dry-run to execute the deletion.');
		process.exit(0);
	}
	if (summary.errors > 0) {
		console.error('\nSome deletions failed. Check the error messages above.');
		process.exit(1);
	}
	console.log('\nAll content deleted successfully!');
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
