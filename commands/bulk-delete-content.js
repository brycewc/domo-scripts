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
 *   beast-mode   POST   /query/v1/functions/bulk/template { delete: [...] } (bulk)
 *   variable     POST   /query/v1/functions/bulk/template { delete: [...] } (bulk)
 *   page         DELETE /content/v1/pages/{id}                             (per-item)
 *   alert        DELETE /social/v4/alerts/{id}                             (per-item)
 *   scheduled-report
 *                DELETE /content/v1/reportschedules/{id}                   (per-item)
 *   app-studio   DELETE /content/v1/dataapps/{appId}                       (per-item)
 *   worksheet    DELETE /content/v1/dataapps/{id}                          (per-item)
 *   custom-app   DELETE /apps/v1/designs/{id}                              (per-item)
 *   code-engine  DELETE /codeengine/v2/packages/{id}                       (per-item)
 *   jupyter      DELETE /datascience/v1/workspaces/{id}                    (per-item)
 *   ai-project   DELETE /datascience/ml/v1/projects/{id}                   (per-item)
 *   ai-model     DELETE /datascience/ml/v1/models/{id}                     (per-item)
 *   workflow     DELETE /workflow/v1/models/{id}                           (per-item)*
 *   project      DELETE /content/v1/projects/{id}                          (per-item)
 *   project-task DELETE /content/v1/projects/{projectId}/tasks/{id}        (per-item)
 *   goal         DELETE /social/v1/objectives/{id}                         (per-item)
 *   metric       DELETE /content/v1/metrics/{id}?hardDelete=true           (per-item)
 *   fileset      DELETE /files/v1/filesets/{id}                            (per-item)
 *   collection   DELETE /datastores/v1/collections/{id}                    (per-item)
 *   account      DELETE /accounts/v1/accounts/{id}                         (per-item)
 *   workspace    DELETE /nav/v1/workspaces/{workspaceGUID}                 (per-item)
 *
 * project-task has no standalone delete endpoint — the parent projectId is
 * resolved first via GET /content/v1/tasks/{id}, then the task is deleted under
 * its project. workflow (*) deactivates any active versions first — the delete
 * endpoint rejects a model that still has an active version — by listing
 * GET /workflow/v2/models/{id}/versions and PUTting each active one back with
 * active:false before the DELETE. jupyter is the activity-log
 * DATA_SCIENCE_NOTEBOOK type (the API
 * calls those "Jupyter workspaces") — that is a DIFFERENT thing from workspace,
 * which is the navigation Workspaces feature (nav/v1/workspaces, keyed by GUID).
 * worksheet reuses the same /content/v1/dataapps/{id} endpoint as app-studio
 * (both are "dataapps"); only the activity-log label differs. metric is the
 * activity-log METRIC type — the content/v1/metrics resource discovered by
 * bulk-list-user-content via /content/v1/metrics/filter, deleted at
 * /content/v1/metrics/{id} with hardDelete=true for a permanent delete (the
 * endpoint only archives/soft-deletes without it). This is NOT the unrelated
 * Beast Mode calc metrics at /social/v1/calc/metrics.
 *
 * Users are intentionally NOT handled here — delete them with bulk-delete-users.
 *
 * WARNING: This is a destructive operation. Deleted content cannot be recovered.
 * Use --dry-run to preview which objects would be deleted before committing.
 *
 * Objects that are already gone (HTTP 404/410 — stale CSV row, duplicate id,
 * re-run after a partial failure, or cascade removal) are reported as "already
 * gone" and skipped, not counted as errors. (Some Domo endpoints return 403/400
 * for a non-existent id; those stay genuine errors since they're ambiguous with
 * real auth/validation failures.)
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
 *   # Delete dataflows AND the datasets they output
 *   node cli.js bulk-delete-content --object-types "dataflow" --ids "123,456" --delete-output-datasets
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
 *   --delete-output-datasets
 *                    Dataflows only: also delete every output dataset of each
 *                    dataflow being deleted. Each dataflow definition is fetched
 *                    (a read-only GET, done even under --dry-run so the preview
 *                    is complete) to enumerate its outputs; the outputs join the
 *                    normal dataset pass, which already runs before the dataflow
 *                    pass. A dataflow whose outputs cannot be listed is NOT
 *                    deleted — deleting it would orphan output datasets with no
 *                    remaining way to find them — and is counted as an error.
 *   --dry-run        Preview which objects would be deleted without deleting
 *
 * Types are deleted in a fixed dependency-safe order (alert, scheduled-report,
 * card, page, app-studio, worksheet, custom-app, code-engine, jupyter,
 * ai-project, ai-model, workflow, project-task, project, beast-mode, variable,
 * goal, metric, fileset, dataset, dataflow, account, collection, group,
 * workspace) so dependents go before what they reference (beast modes,
 * variables, goals, metrics and filesets before the datasets they sit on).
 * workspace is last because a workspace can contain any other content, so
 * everything it holds is deleted first. Deletes within a single type run
 * concurrently; types do not overlap.
 */

const { api, readCSV, createLogger, showHelp } = require('../lib');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-delete-content [options]

WARNING: This is a destructive operation. Deleted content cannot be recovered.

Routes each row to the correct DELETE endpoint by object type. Consumes the CSV
that bulk-list-user-content emits ("Object Type" + "Object ID" columns).

Supported types: dataflow, card, dataset, group, beast-mode, variable, page,
alert, scheduled-report, app-studio, worksheet, custom-app, code-engine,
jupyter, ai-project, ai-model, workflow, project, project-task, goal, metric,
fileset, collection, account, workspace.
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
  --delete-output-datasets
                   Dataflows only: also delete each dataflow's output datasets.
                   Fetches every dataflow definition (even with --dry-run, so the
                   preview lists the datasets) and deletes the outputs in the
                   normal dataset pass, before the dataflows. A dataflow whose
                   outputs can't be listed is skipped and counted as an error
                   rather than deleted without its outputs.
  --dry-run        Preview without deleting

Types are deleted in a fixed dependency-safe order: alert, scheduled-report,
card, page, app-studio, worksheet, custom-app, code-engine, jupyter,
ai-project, ai-model, workflow, project-task, project, beast-mode, variable,
goal, metric, fileset, dataset, dataflow, account, collection, group,
workspace. workspace is last because a workspace can contain any other content,
so its contents go first.
Deletes within a type run concurrently; types never overlap.

Objects already gone (HTTP 404/410) are reported as "already gone" and skipped,
not counted as errors, so re-runs and stale rows don't fail the command.

Accepted type names (case-insensitive, '-' and '_' interchangeable). The
activity-log labels emitted by bulk-list-user-content are accepted too:
  dataflow     (DATAFLOW_TYPE)
  card         (CARD)
  dataset      (DATA_SOURCE)
  group        (GROUP)
  beast-mode   (BEAST_MODE_FORMULA, beastmode, beast-mode-formula) — beast modes
               (functions); deletes by template id regardless of usage
  variable     (VARIABLE) — variables are functions too; same endpoint and
               caveat as beast-mode
  page         (PAGE)
  alert        (ALERT)
  scheduled-report
               (REPORT_SCHEDULE, report-schedule) — emailed report schedules
  app-studio   (DATA_APP, data-app)
  worksheet    (WORKSHEET) — dataapps; same endpoint as app-studio
  custom-app   (RYUU_APP, app, ryuu)
  code-engine  (CODEENGINE_PACKAGE, codeengine) — Code Engine packages (UUID id)
  jupyter      (DATA_SCIENCE_NOTEBOOK, jupyter-workspace) — data science
               notebooks; NOT the same as workspace
  ai-project   (AI_PROJECT)
  ai-model     (AI_MODEL) — data science models
  workflow     (WORKFLOW_MODEL)
  project      (PROJECT)
  project-task (PROJECT_TASK)
  goal         (OBJECTIVE) — goals/objectives
  metric       (METRIC) — permanently deleted (hardDelete); content/v1 metrics,
               not Beast Mode calc metrics
  fileset      (FILESET)
  collection   (MAGNUM_COLLECTION, appdb-collection)
  account      (ACCOUNT)
  workspace    (WORKSPACE) — navigation Workspaces feature, keyed by GUID`;

// Canonical type → accepted aliases. Includes the activity-log labels that
// bulk-list-user-content writes into its "Object Type" column, normalized to
// lower-case with underscores → hyphens (see normalizeType).
const TYPE_ALIASES = {
	account: ['account'],
	'ai-model': ['ai-model'],
	'ai-project': ['ai-project'],
	alert: ['alert'],
	'app-studio': ['app-studio', 'appstudio', 'data-app', 'dataapp'],
	'beast-mode': ['beast-mode', 'beastmode', 'beast-mode-formula'],
	card: ['card'],
	'code-engine': ['code-engine', 'codeengine', 'codeengine-package'],
	collection: ['collection', 'appdb-collection', 'magnum-collection'],
	'custom-app': ['custom-app', 'app', 'ryuu', 'ryuu-app'],
	dataflow: ['dataflow', 'dataflow-type'],
	dataset: ['dataset', 'datasource', 'data-source'],
	fileset: ['fileset'],
	goal: ['goal', 'objective'],
	group: ['group'],
	jupyter: ['jupyter', 'jupyter-workspace', 'data-science-notebook'],
	metric: ['metric'],
	page: ['page'],
	project: ['project'],
	'project-task': ['project-task'],
	'scheduled-report': ['scheduled-report', 'report-schedule'],
	variable: ['variable'],
	workflow: ['workflow', 'workflow-model'],
	worksheet: ['worksheet'],
	workspace: ['workspace']
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
		single: (id) => api.del(`/data/v3/datasources/${id}`),
		// The dataset bulk endpoint returns HTTP 2xx even when individual datasets
		// are rejected (e.g. "Frozen"), listing them in a `failed` map keyed by id.
		// Trust only that map: any chunk id NOT in `failed` was deleted.
		parseBulkResult: (response, chunk) => {
			const failedMap = response && typeof response.failed === 'object' && response.failed ? response.failed : {};
			const failed = Object.entries(failedMap).map(([id, reason]) => ({
				id: String(id),
				reason: typeof reason === 'string' ? reason : JSON.stringify(reason)
			}));
			const failedIds = new Set(failed.map((f) => f.id));
			const succeeded = chunk.filter((id) => !failedIds.has(String(id)));
			return { succeeded, failed };
		}
	},
	group: {
		label: 'group',
		bulk: (ids) => api.del('/content/v2/groups', ids.map((id) => Number(id))),
		single: (id) => api.del(`/content/v2/groups/${id}`)
	},
	// Beast modes and variables are both "functions" and share these endpoints —
	// the list command just emits them under separate Object Type labels
	// (BEAST_MODE_FORMULA vs VARIABLE), so they're routed as separate types here.
	// The bulk endpoint takes the ids under a `delete` key; the single endpoint
	// deletes one template by id. Both delete by id regardless of whether the
	// function is in use — unlike delete-unused-beast-modes, which only removes
	// ones with no active links.
	'beast-mode': {
		label: 'beast mode',
		bulk: (ids) => api.post('/query/v1/functions/bulk/template', { delete: ids.map((id) => Number(id)) }),
		single: (id) => api.del(`/query/v1/functions/template/${id}`)
	},
	variable: {
		label: 'variable',
		bulk: (ids) => api.post('/query/v1/functions/bulk/template', { delete: ids.map((id) => Number(id)) }),
		single: (id) => api.del(`/query/v1/functions/template/${id}`)
	},
	page: {
		label: 'page',
		single: (id) => api.del(`/content/v1/pages/${id}`)
	},
	alert: {
		label: 'alert',
		single: (id) => api.del(`/social/v4/alerts/${id}`)
	},
	'scheduled-report': {
		// Emailed report schedules (activity-log REPORT_SCHEDULE), the same resource
		// bulk-transfer-ownership rehomes via PUT /content/v1/reportschedules/{id}.
		label: 'scheduled report',
		single: (id) => api.del(`/content/v1/reportschedules/${id}`)
	},
	'app-studio': {
		label: 'app studio app',
		single: (id) => api.del(`/content/v1/dataapps/${id}`)
	},
	worksheet: {
		// Worksheets are "dataapps" too, so they share app-studio's endpoint —
		// only the activity-log label (WORKSHEET vs DATA_APP) differs.
		label: 'worksheet',
		single: (id) => api.del(`/content/v1/dataapps/${id}`)
	},
	'custom-app': {
		// "Custom apps" (activity-log RYUU_APP) are app designs. deleteDesign is a
		// soft-delete — recoverable via PUT /apps/v1/designs/{id}/undelete.
		label: 'custom app',
		single: (id) => api.del(`/apps/v1/designs/${id}`)
	},
	'code-engine': {
		// Code Engine packages (activity-log CODEENGINE_PACKAGE). The id is a UUID.
		label: 'Code Engine package',
		single: (id) => api.del(`/codeengine/v2/packages/${id}`)
	},
	jupyter: {
		label: 'Jupyter workspace',
		single: (id) => api.del(`/datascience/v1/workspaces/${id}`)
	},
	'ai-project': {
		label: 'AI project',
		single: (id) => api.del(`/datascience/ml/v1/projects/${id}`)
	},
	'ai-model': {
		label: 'AI model',
		single: (id) => api.del(`/datascience/ml/v1/models/${id}`)
	},
	workflow: {
		// DELETE /workflow/v1/models/{id} rejects models that still have an active
		// version, so list the model's versions and deactivate any active ones
		// (PUT each back with active:false, preserving its description) before the
		// delete. If the model is already gone, the versions GET 404s and is caught
		// upstream as "already gone", same as project-task's parent-project lookup.
		label: 'workflow',
		single: async (id) => {
			const versions = await api.get(`/workflow/v2/models/${id}/versions`);
			const activeVersions = (versions || []).filter((v) => v && v.active);
			for (const ver of activeVersions) {
				await api.put(`/workflow/v2/models/${id}/versions/${ver.version}`, {
					active: false,
					description: ver.description
				});
			}
			return api.del(`/workflow/v1/models/${id}`);
		}
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
	goal: {
		// Goals (activity-log OBJECTIVE). Numeric id.
		label: 'goal',
		single: (id) => api.del(`/social/v1/objectives/${id}`)
	},
	metric: {
		// Metrics (activity-log METRIC) — the content/v1/metrics resource that
		// bulk-list-user-content discovers via /content/v1/metrics/filter, NOT the
		// unrelated Beast Mode calc metrics at /social/v1/calc/metrics. hardDelete=true
		// permanently removes it; without it the endpoint only archives/soft-deletes.
		// Numeric id.
		label: 'metric',
		single: (id) => api.del(`/content/v1/metrics/${id}?hardDelete=true`)
	},
	fileset: {
		// FileSets (activity-log FILESET). The id is a UUID.
		label: 'fileset',
		single: (id) => api.del(`/files/v1/filesets/${id}`)
	},
	collection: {
		label: 'AppDB collection',
		single: (id) => api.del(`/datastores/v1/collections/${id}`)
	},
	account: {
		label: 'account',
		single: (id) => api.del(`/accounts/v1/accounts/${id}`)
	},
	workspace: {
		// The navigation Workspaces feature (NOT Jupyter "workspaces" — that's the
		// `jupyter` type). Keyed by workspace GUID; "Safe Delete Workspace".
		label: 'workspace',
		single: (id) => api.del(`/nav/v1/workspaces/${id}`)
	}
};

// Order types are deleted in. This is dependency-safe, not cosmetic: dependents
// are removed before the things they reference (e.g. alerts and scheduled
// reports before the cards and pages they watch or email,
// cards/pages/apps/notebooks and beast modes/variables/
// goals/metrics/filesets before the datasets they sit on, datasets before the
// dataflows that produce them, project tasks before
// their parent project — which would otherwise take the tasks with it and 404
// the per-task deletes), so we never orphan or block a downstream delete. Groups
// go near the end, since other content references them for access. Workspaces go
// dead last: a workspace can contain virtually any other content (cards, pages,
// dataflows, datasets, ...), so everything it holds is deleted first. Types are
// processed strictly in this order; only the deletes WITHIN a type may run
// concurrently.
const TYPE_ORDER = [
	'alert',
	'scheduled-report',
	'card',
	'page',
	'app-studio',
	'worksheet',
	'custom-app',
	'code-engine',
	'jupyter',
	'ai-project',
	'ai-model',
	'workflow',
	'project-task',
	'project',
	'beast-mode',
	'variable',
	'goal',
	'metric',
	'fileset',
	'dataset',
	'dataflow',
	'account',
	'collection',
	'group',
	'workspace'
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 404/410 mean the object is already gone (stale row, duplicate id, re-run, or
// cascade removal) — a success for our purposes, not a failure. Note: per past
// findings, some Domo DELETE endpoints return 403/400 for a non-existent id;
// those are deliberately NOT treated as "gone" since they're ambiguous with
// real auth/validation errors. Only 405 means the verb is unsupported.
const isAlreadyGone = (err) => err && (err.status === 404 || err.status === 410);

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

// --delete-output-datasets: fetch each dataflow's definition and append its
// output dataset IDs to the dataset work list (deduped against datasets already
// listed), so the outputs are deleted in the normal dataset pass — which
// TYPE_ORDER already runs before the dataflow pass. Runs even under --dry-run
// (the GETs are read-only) so the preview shows the datasets that would go.
// A dataflow that is already gone (404/410) stays in the work list for the
// delete pass to report as such. Any other fetch failure REMOVES the dataflow
// from the work list: deleting it blind would orphan output datasets with no
// remaining way to find them. Failures are returned for the caller to count as
// errors. Mutates objectsByType in place.
async function expandDataflowOutputs(objectsByType, concurrency) {
	const dataflowIds = objectsByType.dataflow;
	const datasetIds = new Set((objectsByType.dataset || []).map(String));
	const added = [];
	const outputsByDataflow = {};
	const failures = [];

	console.log(`Listing output datasets for ${dataflowIds.length} dataflow(s)...`);
	await mapWithConcurrency(dataflowIds, concurrency, async (dataflowId) => {
		try {
			const definition = await api.get(`/dataprocessing/v2/dataflows/${dataflowId}`);
			const outputs = (definition.outputs || [])
				.map((output) => output && output.dataSourceId)
				.filter(Boolean)
				.map(String);
			outputsByDataflow[dataflowId] = outputs;
			for (const datasetId of outputs) {
				if (!datasetIds.has(datasetId)) {
					datasetIds.add(datasetId);
					added.push(datasetId);
				}
			}
			console.log(`  dataflow ${dataflowId}: ${outputs.length} output dataset(s)`);
		} catch (error) {
			if (isAlreadyGone(error)) {
				console.log(`  ↷ dataflow ${dataflowId} already gone — no outputs to list`);
			} else {
				failures.push({ dataflowId: String(dataflowId), error: error.message });
				console.error(`  ✗ dataflow ${dataflowId}: could not list outputs — ${error.message}`);
			}
		}
		await delay(100);
	});

	if (added.length > 0) {
		objectsByType.dataset = (objectsByType.dataset || []).concat(added);
	}
	if (failures.length > 0) {
		const failed = new Set(failures.map((f) => f.dataflowId));
		objectsByType.dataflow = dataflowIds.filter((id) => !failed.has(String(id)));
		console.warn(`  Skipping ${failed.size} dataflow(s) whose outputs could not be listed — they will NOT be deleted.`);
	}
	console.log(`  ${added.length} output dataset(s) added to the delete list.\n`);

	return { added, outputsByDataflow, failures };
}

async function deleteType(type, ids, { dryRun, batchSize, concurrency, logger }) {
	const deleter = DELETERS[type];
	console.log(`\n=== ${type} (${ids.length}) ===`);

	if (dryRun) {
		for (const id of ids) {
			console.log(`  [DRY RUN] Would delete ${deleter.label} ${id}`);
			logger.addResult({ objectType: type, objectId: id, status: 'dry-run' });
		}
		return { deleted: ids.length, errors: 0, skipped: 0 };
	}

	let deleted = 0;
	let errors = 0;
	let skipped = 0;

	if (deleter.bulk) {
		const totalBatches = Math.ceil(ids.length / batchSize);

		// Used when the whole batch CALL throws: fall back to deleting the chunk
		// one id at a time so a single bad id doesn't sink the rest of the batch.
		const retryIndividually = async (chunk, batchNumber) => {
			for (const id of chunk) {
				try {
					await deleter.single(id);
					console.log(`      ✓ ${deleter.label} ${id} deleted`);
					logger.addResult({ objectType: type, objectId: id, status: 'deleted', batch: batchNumber, retried: true });
					deleted++;
				} catch (singleError) {
					if (isAlreadyGone(singleError)) {
						console.log(`      ↷ ${deleter.label} ${id} already gone (skipped)`);
						logger.addResult({ objectType: type, objectId: id, status: 'skipped', reason: 'already-deleted', batch: batchNumber });
						skipped++;
					} else {
						console.error(`      ✗ ${deleter.label} ${id} failed: ${singleError.message}`);
						logger.addResult({ objectType: type, objectId: id, status: 'error', error: singleError.message, batch: batchNumber });
						errors++;
					}
				}
				await delay(150);
			}
		};

		for (let i = 0; i < ids.length; i += batchSize) {
			const chunk = ids.slice(i, i + batchSize);
			const batchNumber = Math.floor(i / batchSize) + 1;
			console.log(`  [${batchNumber}/${totalBatches}] Deleting ${chunk.length} ${deleter.label}(s)...`);
			try {
				const response = await deleter.bulk(chunk);
				// A non-throwing bulk call doesn't always mean every id was deleted —
				// some endpoints (dataset) return 2xx with a `failed` map. parseBulkResult
				// separates server-rejected ids; without it we assume the whole chunk went.
				const { succeeded, failed } = deleter.parseBulkResult
					? deleter.parseBulkResult(response, chunk)
					: { succeeded: chunk, failed: [] };

				for (const id of succeeded) {
					logger.addResult({ objectType: type, objectId: id, status: 'deleted', batch: batchNumber });
					deleted++;
				}

				if (failed.length === 0) {
					console.log(`    ✓ Batch ${batchNumber} succeeded`);
				} else {
					// The bulk endpoint reported these ids in its `failed` map but still
					// returned 2xx. That can be a transient/endpoint-specific failure
					// (the dataset bulk endpoint sometimes leaks an internal servlet
					// error), so retry them one at a time via the single-delete path —
					// a different endpoint — which also distinguishes already-gone.
					console.error(`    ⚠ Batch ${batchNumber}: ${succeeded.length} deleted, ${failed.length} reported failed by the bulk endpoint`);
					console.log(`    Retrying ${failed.length} ${deleter.label}(s) individually...`);
					await retryIndividually(failed.map((f) => f.id), batchNumber);
				}
			} catch (error) {
				console.error(`    ✗ Batch ${batchNumber} failed: ${error.message}`);
				console.log(`    Retrying ${chunk.length} ${deleter.label}(s) individually...`);
				await retryIndividually(chunk, batchNumber);
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
				if (isAlreadyGone(error)) {
					logger.addResult({ objectType: type, objectId: id, status: 'skipped', reason: 'already-deleted' });
					skipped++;
					console.log(`  ↷ [${++done}/${ids.length}] ${deleter.label} ${id} already gone (skipped)`);
				} else {
					logger.addResult({ objectType: type, objectId: id, status: 'error', error: error.message });
					errors++;
					console.error(`  ✗ [${++done}/${ids.length}] ${deleter.label} ${id} failed: ${error.message}`);
				}
			}
		});
	}

	return { deleted, errors, skipped };
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const dryRun = argv['dry-run'] || argv.dry || false;
	const batchSize = parseInt(argv['batch-size'] || argv.b || '50', 10);
	const concurrency = Math.max(1, parseInt(argv.concurrency || '5', 10));
	const deleteOutputDatasets = argv['delete-output-datasets'] || false;

	const requestedTypes = parseRequestedTypes();
	const objectsByType = buildObjectsByType(requestedTypes);

	console.log('Bulk Delete Content');
	console.log('===================\n');
	if (dryRun) console.log('*** DRY RUN — no content will be deleted ***\n');

	let outputExpansion = null;
	if (deleteOutputDatasets) {
		if ((objectsByType.dataflow || []).length > 0) {
			outputExpansion = await expandDataflowOutputs(objectsByType, concurrency);
		} else {
			console.warn('--delete-output-datasets: no dataflows in the work list, nothing to expand.\n');
		}
	}
	const expansionFailures = outputExpansion ? outputExpansion.failures : [];

	const typesToProcess = TYPE_ORDER.filter((t) => objectsByType[t] && objectsByType[t].length > 0);
	const totalObjects = typesToProcess.reduce((n, t) => n + objectsByType[t].length, 0);

	if (totalObjects === 0 && expansionFailures.length === 0) {
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
			deleteOutputDatasets,
			countsByType: Object.fromEntries(typesToProcess.map((t) => [t, objectsByType[t].length]))
		}
	});

	console.log(`Batch Size:  ${batchSize}`);
	console.log(`Concurrency: ${concurrency}`);
	console.log(`Objects:     ${totalObjects}`);
	for (const t of typesToProcess) console.log(`  ${t}: ${objectsByType[t].length}`);

	const summary = { totals: {}, deleted: 0, errors: 0, skipped: 0 };
	for (const f of expansionFailures) {
		logger.addResult({
			objectType: 'dataflow',
			objectId: f.dataflowId,
			status: 'error',
			error: `not deleted — could not list output datasets: ${f.error}`
		});
		summary.errors++;
	}
	for (const type of typesToProcess) {
		const { deleted, errors, skipped } = await deleteType(type, objectsByType[type], { dryRun, batchSize, concurrency, logger });
		summary.totals[type] = { deleted, errors, skipped };
		summary.deleted += deleted;
		summary.errors += errors;
		summary.skipped += skipped;
	}

	const verb = dryRun ? 'would delete' : 'deleted';
	console.log('\n=== Summary ===');
	for (const type of typesToProcess) {
		const t = summary.totals[type];
		const extras = [t.skipped ? `${t.skipped} already gone` : null, t.errors ? `${t.errors} errors` : null].filter(Boolean);
		console.log(`  ${type}: ${t.deleted} ${verb}${extras.length ? `, ${extras.join(', ')}` : ''}`);
	}
	if (expansionFailures.length > 0) {
		console.log(`  dataflow: ${expansionFailures.length} not deleted (output datasets could not be listed)`);
	}
	console.log(`Total ${verb}: ${summary.deleted}`);
	if (summary.skipped > 0) console.log(`Total already gone: ${summary.skipped}`);
	console.log(`Total errors:  ${summary.errors}`);

	logger.writeRunLog({
		total: totalObjects,
		deleted: summary.deleted,
		errors: summary.errors,
		skipped: summary.skipped,
		byType: summary.totals,
		...(outputExpansion
			? {
					outputDatasetsAdded: outputExpansion.added.length,
					outputDatasetsByDataflow: outputExpansion.outputsByDataflow,
					outputExpansionFailures: outputExpansion.failures
				}
			: {})
	});

	if (dryRun) {
		console.log('\nRe-run without --dry-run to execute the deletion.');
		process.exit(summary.errors > 0 ? 1 : 0);
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
