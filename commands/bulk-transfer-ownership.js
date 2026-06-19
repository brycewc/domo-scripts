/**
 * Bulk transfer ownership of Domo content from one user to another.
 *
 * Two modes for choosing what to transfer:
 *   1) From user  — discover every object owned by --from-user and transfer it
 *   2) From file  — read specific object IDs (optionally mixed types) from a CSV
 *
 * --from-user may be omitted when --file is used together with
 * --keep-previous-owner. In that mode, the listed IDs are assigned to --to-user
 * without removing any existing owner — useful when the objects in the CSV
 * have no owner currently assigned.
 *
 * Usage:
 *   # Transfer every type the user owns
 *   node cli.js bulk-transfer-ownership --from-user 12345 --to-user 67890
 *
 *   # Transfer only specific types owned by the user
 *   node cli.js bulk-transfer-ownership --from-user 12345 --to-user 67890 --object-types "dataset,dataflow,card"
 *
 *   # Transfer a CSV of mixed content — CSV has a type column
 *   node cli.js bulk-transfer-ownership --from-user 12345 --to-user 67890 --file content.csv --type-column "Object Type ID"
 *
 *   # Transfer a CSV that is all one type — no type column needed
 *   node cli.js bulk-transfer-ownership --from-user 12345 --to-user 67890 --file datasets.csv --object-types "dataset"
 *
 *   # Assign ownership for a CSV without specifying a previous owner
 *   node cli.js bulk-transfer-ownership --to-user 67890 --file datasets.csv --object-types "dataset" --keep-previous-owner
 *
 *   # Route each row to a different new owner read from a CSV column
 *   node cli.js bulk-transfer-ownership --from-user 12345 --file content.csv --type-column "Object Type ID" --to-user-column "New Owner ID"
 *
 * When dataflows are transferred, the new owner is granted access to any input
 * dataset they can't already reach (directly or via a group). Control the grant
 * level with --input-access-level (default CAN_VIEW).
 *
 * Object types (aliases accepted: DATA_SOURCE, dataflow_type, beast_mode_formula, data_app, etc.):
 *   account, ai-model, ai-project, alert, app-studio, approval, beast-mode, card,
 *   code-engine, collection, custom-app, dataflow, dataset, fileset, goal, group,
 *   jupyter, metric, page, project, project-task, publication, queue, repository,
 *   scheduled-report, subscription, task, template, variable, workflow,
 *   worksheet, workspace
 *
 * Function ordering in this file is enforced by eslint-plugin-perfectionist
 * (see eslint.config.js). `_main` is pinned to the top; every other function
 * is alphabetical.
 */

const api = require('../lib/api');
const { readCSV } = require('../lib/csv');
const { showHelp } = require('../lib/help');
const { createLogger } = require('../lib/log');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-transfer-ownership [options]

Transfer ownership of Domo content from one user to another.

Required:
  --to-user <id>       New owner's user ID (destination). Not required when
                       --to-user-column is used (the new owner comes from the CSV).
  --from-user <id>     Current owner's user ID (source). Required unless using
                       --file together with --keep-previous-owner.

Optional:
  --file <path>        CSV file with specific IDs to transfer (instead of discovering everything)
  --id-column <name>   CSV column with object IDs (default: "Object ID")
  --to-user-column <name> CSV column holding the destination user ID per row. Only valid
                       with --file. Rows are grouped by this value and each new owner is
                       processed in turn, so different objects can go to different owners
                       in one run. Overrides --to-user.
  --type-column <name> CSV column with object type per row — needed when the CSV mixes types
  --object-types <csv> Comma-separated list of types to include. Omit to transfer every type.
                       When --file is used without --type-column, this must be exactly one type
                       and is applied to every row.
  --keep-previous-owner Do NOT remove the previous owner for types that support multiple
                       owners (card, app-studio, page, worksheet, group, repository, workspace).
                       Required when --from-user is omitted (only valid with --file). Useful
                       when the listed objects have no current owner assigned.
  --input-access-level <level> Access level granted to the new owner on a transferred
                       dataflow's input datasets when they don't already have access
                       (directly or via group). One of CAN_VIEW, CAN_EDIT, CAN_SHARE, OWNER.
                       Default: CAN_VIEW.
  --send-email         After transferring, email the new owner a summary of every
                       asset that was transferred to them (by type, with IDs). Skipped
                       on a dry run.
  --dry-run            Print what would be transferred without calling any write endpoints
  --help               Show this help

Object types (case-insensitive, hyphens or underscores both accepted):
  account, ai-model, ai-project, alert, app-studio, approval, beast-mode, card,
  code-engine, collection, custom-app, dataflow, dataset, fileset, goal, group,
  jupyter, metric, page, project, project-task, publication, queue, repository,
  scheduled-report, subscription, task, template, variable, workflow,
  worksheet, workspace

Notes:
  - When a dataflow is transferred, the new owner is checked for access to each of the
    dataflow's input datasets (direct USER grant or inherited via group membership). Any
    input they can't reach is shared with them directly (see --input-access-level).
  - "publication" is never actually transferred (platform limitation); it is only reported.
  - "approval" and "template" only discover from the --from-user; they ignore filtered IDs.
  - "goal" only discovers from the --from-user; it ignores filtered IDs.
  - When --from-user is omitted, "approval", "template", and "goal" cannot be processed.`;

// Canonical type → list of accepted aliases
const TYPE_ALIASES = {
	account: ['account'],
	'ai-model': ['ai-model', 'ai_model'],
	'ai-project': ['ai-project', 'ai_project'],
	alert: ['alert'],
	'app-studio': ['app-studio', 'appstudio', 'data-app', 'data_app', 'dataapp'],
	approval: ['approval'],
	'beast-mode': ['beast-mode', 'beastmode', 'beast_mode', 'beast-mode-formula', 'beast_mode_formula'],
	card: ['card'],
	'code-engine': ['code-engine', 'codeengine', 'code_engine', 'codeengine-package', 'codeengine_package'],
	collection: ['collection', 'appdb-collection', 'appdb_collection'],
	'custom-app': ['custom-app', 'app', 'ryuu', 'ryuu-app', 'ryuu_app'],
	dataflow: ['dataflow', 'dataflow-type', 'dataflow_type'],
	dataset: ['dataset', 'datasource', 'data-source', 'data_source'],
	fileset: ['fileset'],
	goal: ['goal'],
	group: ['group'],
	jupyter: ['jupyter', 'jupyter-workspace', 'data-science-notebook', 'data_science_notebook'],
	metric: ['metric'],
	page: ['page'],
	project: ['project'],
	'project-task': ['project-task', 'project_task'],
	publication: ['publication'],
	queue: ['queue', 'hopper-queue', 'hopper_queue', 'task-center-queue'],
	repository: ['repository', 'sandbox-repository'],
	'scheduled-report': ['scheduled-report', 'scheduled_report', 'report-schedule', 'report_schedule'],
	subscription: ['subscription'],
	task: ['task', 'hopper-task', 'hopper_task', 'task-center-task'],
	template: ['template', 'approval-template', 'approval_template'],
	variable: ['variable'],
	workflow: ['workflow', 'workflow-model', 'workflow_model'],
	worksheet: ['worksheet'],
	workspace: ['workspace']
};

const ALIAS_TO_CANONICAL = {};
for (const [canonical, aliases] of Object.entries(TYPE_ALIASES)) {
	for (const alias of aliases) {
		ALIAS_TO_CANONICAL[alias] = canonical;
	}
}

const ALL_TYPES = Object.keys(TYPE_ALIASES);

// Types that only work in "from --from-user" mode (filteredIds is not supported).
const DISCOVERY_ONLY_TYPES = new Set(['approval', 'template', 'goal']);

// Dataset access levels accepted by --input-access-level (used when granting the
// new owner access to a transferred dataflow's input datasets).
const DATASET_ACCESS_LEVELS = ['CAN_VIEW', 'CAN_EDIT', 'CAN_SHARE', 'OWNER'];

const HANDLERS = {
	dataset: transferDatasets,
	dataflow: transferDataflows,
	card: transferCards,
	alert: transferAlerts,
	workflow: transferWorkflows,
	queue: transferTaskCenterQueues,
	task: transferTaskCenterTasks,
	'app-studio': transferAppStudioApps,
	page: transferPages,
	'scheduled-report': transferScheduledReports,
	goal: transferGoals,
	group: transferGroups,
	collection: transferAppDbCollections,
	account: transferAccounts,
	jupyter: transferJupyterWorkspaces,
	'code-engine': transferCodeEnginePackages,
	fileset: transferFilesets,
	publication: reportPublications,
	subscription: transferSubscriptions,
	repository: transferRepositories,
	'custom-app': transferCustomApps,
	'ai-model': transferAiModels,
	'ai-project': transferAiProjects,
	metric: transferMetrics,
	approval: transferApprovals,
	template: transferApprovalTemplates,
	worksheet: transferWorksheets,
	workspace: transferWorkspaces
};

// Types handled outside the per-type loop because they share an underlying API.
const COALESCED_TYPES = new Set(['beast-mode', 'variable', 'project', 'project-task']);

// Errors swallowed by safe() are collected here so they make it into the run
// log instead of only being printed to the console. activeType tags each
// failure with the type being processed when it occurred.
const failures = [];
let activeType = null;

// -----------------------------------------------------------------------------
// Entry point — pinned to the top by the `entry` custom group in
// eslint.config.js. Renamed from `main` to `_main` so perfectionist's sort
// keeps it above every alphabetised transfer function.
// -----------------------------------------------------------------------------

async function _main() {
	showHelp(argv, HELP_TEXT);

	const fromUserId = argv['from-user'];
	const toUserId = argv['to-user'];
	const toUserColumn = argv['to-user-column'];
	const filePath = argv.file;
	const typeColumn = argv['type-column'];
	const idColumn = argv['id-column'] || 'Object ID';
	const dryRun = Boolean(argv['dry-run']);
	const sendEmailFlag = Boolean(argv['send-email']);
	const keepPreviousOwner = Boolean(argv['keep-previous-owner']);
	const inputAccessLevel = String(argv['input-access-level'] || 'CAN_VIEW').toUpperCase();

	if (!DATASET_ACCESS_LEVELS.includes(inputAccessLevel)) {
		throw new Error(`Invalid --input-access-level. Must be one of: ${DATASET_ACCESS_LEVELS.join(', ')}`);
	}

	if (toUserColumn && !filePath) {
		throw new Error('--to-user-column can only be used with --file');
	}
	if (!toUserId && !toUserColumn) {
		throw new Error('--to-user is required (or use --to-user-column together with --file)');
	}
	if (!fromUserId) {
		if (!filePath) {
			throw new Error('--from-user is required when --file is not used');
		}
		if (!keepPreviousOwner) {
			throw new Error(
				'--from-user is required. Omit it only with --file and --keep-previous-owner — ' +
					'this acknowledges that previous owners will not be removed for types that support multiple owners.'
			);
		}
	} else if (toUserId && String(fromUserId) === String(toUserId)) {
		throw new Error('--from-user and --to-user must be different');
	}

	let requestedTypes = null;
	if (argv['object-types']) {
		requestedTypes = String(argv['object-types'])
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean)
			.map((t) => {
				const canon = normalizeType(t);
				if (!canon) {
					throw new Error(`Unknown object type: "${t}"`);
				}
				return canon;
			});
	}

	// Build the work groups. Each group is one destination user plus the
	// objectsByType map of what they should receive. Without --file there is a
	// single group whose objectsByType is null (discover everything --from-user
	// owns). With --file we read the CSV; with --to-user-column the rows are
	// partitioned by destination user so different objects can go to different
	// new owners in one run.
	let groups;
	if (filePath) {
		const records = readCSV(filePath);
		if (records.length === 0) throw new Error('CSV file has no rows');
		const columns = Object.keys(records[0]);
		if (!columns.includes(idColumn)) {
			throw new Error(`ID column "${idColumn}" not found in CSV. Available: ${columns.join(', ')}`);
		}
		if (toUserColumn && !columns.includes(toUserColumn)) {
			throw new Error(`To-user column "${toUserColumn}" not found in CSV. Available: ${columns.join(', ')}`);
		}
		if (!typeColumn) {
			if (!requestedTypes || requestedTypes.length !== 1) {
				throw new Error('With --file and no --type-column, --object-types must specify exactly one type.');
			}
		} else if (!columns.includes(typeColumn)) {
			throw new Error(`Type column "${typeColumn}" not found in CSV. Available: ${columns.join(', ')}`);
		}

		const byUser = new Map();
		for (const row of records) {
			const id = row[idColumn];
			if (!id) continue;
			let canon;
			if (typeColumn) {
				canon = normalizeType(row[typeColumn]);
				if (!canon) {
					console.warn(`  Skipping row with id=${id}: unknown type "${row[typeColumn]}"`);
					continue;
				}
				if (requestedTypes && !requestedTypes.includes(canon)) continue;
			} else {
				canon = requestedTypes[0];
			}
			const rowToUser = toUserColumn ? String(row[toUserColumn] || '').trim() : String(toUserId);
			if (!rowToUser) {
				console.warn(`  Skipping row with id=${id}: blank "${toUserColumn}" value.`);
				continue;
			}
			if (!byUser.has(rowToUser)) byUser.set(rowToUser, {});
			const objectsByType = byUser.get(rowToUser);
			if (!objectsByType[canon]) objectsByType[canon] = [];
			objectsByType[canon].push(id);
		}
		groups = [...byUser.entries()].map(([groupToUserId, objectsByType]) => ({ toUserId: groupToUserId, objectsByType }));
		if (groups.length === 0) throw new Error('CSV produced no transferable rows.');
	} else {
		groups = [{ toUserId: String(toUserId), objectsByType: null }];
	}

	const fromUserName = fromUserId ? await getUserName(fromUserId) : null;

	const logger = createLogger('bulk-transfer-ownership', {
		debugMode: false,
		dryRun,
		runMeta: {
			fromUserId: fromUserId || null,
			fromUserName,
			toUserId: toUserColumn ? `multiple (per "${toUserColumn}" column)` : toUserId,
			mode: filePath ? 'file' : 'user',
			file: filePath || null,
			toUserColumn: toUserColumn || null,
			keepPreviousOwner,
			requestedTypes: requestedTypes || 'all'
		}
	});

	console.log('Bulk Transfer Ownership');
	console.log('========================');
	console.log(`From:      ${fromUserId ? `${fromUserName} (${fromUserId})` : '(none — assigning new owner)'}`);
	if (toUserColumn) {
		console.log(`To:        per CSV column "${toUserColumn}" (${groups.length} destination user(s))`);
	} else {
		console.log(`To:        ${toUserId}`);
	}
	console.log(`Mode:      ${filePath ? `file (${filePath})` : 'user discovery'}`);
	if (keepPreviousOwner) console.log('Keep previous owner: previous owner will NOT be removed for multi-owner types.');
	if (sendEmailFlag) console.log('Send email: each new owner will be emailed a summary of transferred assets.');
	if (dryRun) console.log('DRY RUN — no write calls will be made.');

	const summary = { totals: {}, skipped: [], errors: failures };
	const toUserNameCache = {};

	for (const group of groups) {
		const groupToUserId = group.toUserId;
		if (fromUserId && String(fromUserId) === String(groupToUserId)) {
			console.warn(`\nSkipping destination user ${groupToUserId}: same as --from-user.`);
			continue;
		}
		if (!(groupToUserId in toUserNameCache)) {
			toUserNameCache[groupToUserId] = await getUserName(groupToUserId);
		}
		const groupToUserName = toUserNameCache[groupToUserId];

		if (groups.length > 1) {
			console.log(`\n##### Transferring to ${groupToUserName} (${groupToUserId}) #####`);
		}

		const ctx = {
			fromUserId,
			toUserId: groupToUserId,
			fromUserName,
			toUserName: groupToUserName,
			dryRun,
			keepPreviousOwner,
			inputAccessLevel
		};

		const transferredByType = await transferForUser({
			ctx,
			objectsByType: group.objectsByType,
			requestedTypes,
			logger,
			summary
		});

		if (sendEmailFlag) {
			console.log('\n=== email ===');
			activeType = 'email';
			if (dryRun) {
				console.log('  Dry run — skipping email to the new owner.');
			} else {
				await sendTransferEmail({
					toUserId: groupToUserId,
					toUserName: groupToUserName,
					fromUserName,
					transferredByType
				});
			}
		}
	}

	console.log('\n=== Summary ===');
	for (const [type, count] of Object.entries(summary.totals)) {
		console.log(`  ${type}: ${count}`);
	}
	if (summary.skipped.length > 0) {
		console.log('Skipped:');
		for (const s of summary.skipped) {
			console.log(`  ${s.type} (${s.reason}): ${s.ids.length}`);
		}
	}
	if (failures.length > 0) {
		console.log(`Errors:    ${failures.length} (see run log for details)`);
	}
	logger.writeRunLog(summary);
}

// -----------------------------------------------------------------------------
// Every other function below — alphabetical by name. Enforced by
// `perfectionist/sort-modules` in eslint.config.js.
// -----------------------------------------------------------------------------

// Core of safe(): runs fn, and on error logs it + records it in `failures`,
// returning an explicit { ok, value }. The ok flag is needed where a caller
// must distinguish a real failure from a successful empty-body response — the
// API client returns null for both, so safe()'s null return alone is ambiguous.
async function attempt(label, fn, context) {
	try {
		return { ok: true, value: await fn() };
	} catch (err) {
		const message = err.message || String(err);
		console.error(`  ✗ ${label}: ${message}`);
		const failure = { type: activeType, label, message, time: new Date().toISOString() };
		// Bulk calls act on many IDs at once; record what was sent so a failed
		// batch shows which objects were affected instead of just the count.
		if (context !== undefined) failure.context = context;
		failures.push(failure);
		return { ok: false, value: null };
	}
}

// Capture the "From <name>" tag source for each dataflow BEFORE reassigning —
// reassignment overwrites responsibleUserId, so the current owner is only
// available now. With --from-user (fromUserName set) every dataflow is tagged
// from that single name; without it, each dataflow is tagged from whoever
// currently owns it. User IDs are resolved to names once and cached.
async function captureDataflowOwnerNames(ids, fromUserName) {
	const map = {};
	if (fromUserName) {
		for (const id of ids) map[id] = fromUserName;
		return map;
	}
	const nameCache = {};
	for (const id of ids) {
		const df = await safe(`get dataflow owner ${id}`, () => api.get(`/dataprocessing/v1/dataflows/${id}`));
		const ownerId = df && df.responsibleUserId;
		if (ownerId == null) continue;
		if (!(ownerId in nameCache)) nameCache[ownerId] = await getUserName(ownerId);
		if (nameCache[ownerId]) map[id] = nameCache[ownerId];
	}
	return map;
}

// Same idea as captureDataflowOwnerNames, but datasets expose the owner's name
// directly on the datasource detail, so no separate user lookup is needed.
async function captureDatasetOwnerNames(ids, fromUserName) {
	const map = {};
	if (fromUserName) {
		for (const id of ids) map[id] = fromUserName;
		return map;
	}
	for (const id of ids) {
		const ds = await safe(`get dataset owner ${id}`, () => api.get(`/data/v3/datasources/${id}`));
		const owner = ds && ds.owner;
		if (!owner) continue;
		// A dataset can be owned by a group (dataflows can't). There's no sensible
		// "From <person>" tag in that case, so skip tagging it.
		if (owner.type === 'GROUP' || owner.group === true) {
			console.log(`  Skipping tag for dataset ${id}: owned by group "${owner.name}"`);
			continue;
		}
		if (owner.name) map[id] = owner.name;
	}
	return map;
}

// For each transferred dataflow, make sure the new owner can actually read the
// flow's input datasets — otherwise the reassigned dataflow can't run. Access
// may be direct (a USER grant on the dataset) or inherited (a GROUP grant on a
// group the new owner belongs to). Any input the new owner can't already reach
// is shared with them directly as a USER grant. Mirrors the read model:
//   bulk dataset permissions → new owner's group IDs → per-dataset USER/GROUP match.
async function ensureDataflowInputAccess(dataflowIds, toUserId, { dryRun, inputAccessLevel }) {
	// Collect the unique input dataset IDs across every transferred dataflow.
	const datasetIds = new Set();
	for (const dfId of dataflowIds) {
		const df = await safe(`get dataflow inputs ${dfId}`, () => api.get(`/dataprocessing/v1/dataflows/${dfId}`));
		for (const input of (df && df.inputs) || []) {
			if (input && input.dataSourceId) datasetIds.add(String(input.dataSourceId));
		}
	}
	if (datasetIds.size === 0) return { shared: [], alreadyHadAccess: [] };

	const ids = [...datasetIds];
	const [groupIds, permsByDataset] = await Promise.all([getUserGroupIds(toUserId), getDatasetPermissions(ids)]);

	const needsShare = [];
	const alreadyHadAccess = [];
	for (const dsId of ids) {
		const grants = permsByDataset.get(dsId) || [];
		const hasAccess = grants.some(
			(g) =>
				(g.type === 'USER' && String(g.id) === String(toUserId)) ||
				(g.type === 'GROUP' && groupIds.has(String(g.id)))
		);
		if (hasAccess) alreadyHadAccess.push(dsId);
		else needsShare.push(dsId);
	}

	if (needsShare.length === 0) {
		console.log(`  Input dataset access: all ${ids.length} input dataset(s) already reachable by the new owner.`);
		return { shared: [], alreadyHadAccess };
	}

	console.log(
		`  Input dataset access: ${needsShare.length}/${ids.length} not reachable by the new owner` +
			(dryRun ? ' (dry run — not sharing).' : ` — sharing @ ${inputAccessLevel}.`)
	);
	if (dryRun) return { shared: needsShare, alreadyHadAccess };

	const batchSize = 50;
	const shared = [];
	for (let i = 0; i < needsShare.length; i += batchSize) {
		const chunk = needsShare.slice(i, i + batchSize);
		const res = await safe(
			`share input datasets ${i + 1}-${i + chunk.length} with new owner`,
			() =>
				api.post('/data/v1/ui/bulk/share', {
					bulkItems: { ids: chunk, type: 'DATA_SOURCE' },
					dataSourceShareEntity: {
						permissions: [{ accessLevel: inputAccessLevel, id: String(toUserId), type: 'USER' }],
						sendEmail: false,
						message: 'Granting new dataflow owner access to input dataset.'
					}
				}),
			{ ids: chunk }
		);
		// bulk/share reports per-id failures under res.failed; the rest went through.
		const failed = (res && res.failed) || {};
		shared.push(...chunk.filter((id) => !failed[id]));
	}
	console.log(`  → ${shared.length} input dataset(s) shared with the new owner`);
	return { shared, alreadyHadAccess };
}

// Minimal HTML escaping for values interpolated into the --send-email body
// (owner display names, type labels, IDs). Keeps an injected name from breaking
// the surrounding markup.
function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Grant rows for a set of datasets, keyed by dataset ID. Prefers the single
// bulk call; if that endpoint is unavailable (some instances gate it) or omits
// a dataset, falls back to the per-dataset permissions endpoint. Each value is
// an array of { type, id, accessLevel, name } rows.
async function getDatasetPermissions(datasetIds) {
	const byDataset = new Map();
	let bulk = null;
	try {
		bulk = await api.post('/data/v3/datasources/bulk/permissions', datasetIds);
	} catch (_e) {
		// Some instances gate the bulk endpoint; fall back to per-dataset below.
	}
	if (bulk && typeof bulk === 'object') {
		for (const [dsId, val] of Object.entries(bulk)) {
			const grants = Array.isArray(val) ? val : (val && val.list) || [];
			byDataset.set(String(dsId), grants);
		}
	}
	// Fill in any datasets the bulk call didn't cover (or all of them, if it failed).
	for (const dsId of datasetIds) {
		if (byDataset.has(String(dsId))) continue;
		const res = await safe(`get permissions for dataset ${dsId}`, () =>
			api.get(`/data/v3/datasources/${dsId}/permissions`)
		);
		byDataset.set(String(dsId), (res && res.list) || []);
	}
	return byDataset;
}

// New owner's email address — used as the `recipients` query param on the
// messages endpoint (see sendTransferEmail). Returns null if it can't be
// resolved; the message is still routed by recipientsUserIds in that case.
async function getUserEmail(userId) {
	const res = await safe(`get user email ${userId}`, () => api.get(`/content/v3/users/${userId}`));
	return (res && (res.emailAddress || res.email)) || null;
}

// New owner's group IDs (as strings) — one call, used to detect inherited
// dataset access. Returns an empty Set on failure so callers degrade to
// "no inherited access" rather than throwing.
async function getUserGroupIds(userId) {
	const res = await safe(`get groups for user ${userId}`, () => api.get(`/content/v2/users/${userId}/groups`));
	const groups = Array.isArray(res) ? res : [];
	return new Set(groups.filter((g) => g && g.id != null).map((g) => String(g.id)));
}

async function getUserName(fromUserId) {
	const res = await safe(`get user ${fromUserId}`, () => api.get(`/content/v3/users/${fromUserId}`));
	return (res && res.displayName) || `User ${fromUserId}`;
}

// Group object IDs by the tag name captured for each, dropping any with no
// resolved name. Returns Map<name, ids[]> so each owner gets its own
// "From <name>" tag batch.
function groupByTagName(ids, tagNameById) {
	const groups = new Map();
	for (const id of ids) {
		const name = tagNameById[id];
		if (!name) continue;
		if (!groups.has(name)) groups.set(name, []);
		groups.get(name).push(id);
	}
	return groups;
}

async function listPublications(fromUserId) {
	const res = await safe('list publications', () => api.get('/publish/v2/publications'));
	if (!res || res.length === 0) return [];
	const owned = [];
	for (const p of res) {
		const detail = await safe(`get publication ${p.id}`, () => api.get(`/publish/v2/publications/${p.id}`));
		if (detail && detail.content && detail.content.userId == fromUserId) {
			owned.push(p.id);
		}
	}
	return owned;
}

function normalizeType(raw) {
	if (!raw) return null;
	const key = String(raw).trim().toLowerCase().replace(/_/g, '-');
	return ALIAS_TO_CANONICAL[key] || null;
}

async function processFunctionTemplate(template, toUserId) {
	const { valid, invalid } = await sanitizeLinks(template.links);
	const hasInvalidVisible = invalid.some((l) => l.visible === true);
	const allLinksInvalid = template.links && template.links.length === 1 && invalid.length === 1 && valid.length === 0;

	if (allLinksInvalid || hasInvalidVisible) {
		await safe(`delete function ${template.id}`, () => api.del(`/query/v1/functions/template/${template.id}`));
		return { deleted: true, global: template.global };
	}

	if (invalid.length > 0) {
		await safe(`repair function ${template.id} links`, () =>
			api.post(`/query/v1/functions/template/${template.id}/links`, {
				linkTo: valid,
				unlinkFrom: invalid
			})
		);
	}

	return {
		deleted: false,
		global: template.global,
		update: { id: template.id, owner: toUserId, links: valid }
	};
}

// Add the new owner to a list of entity IDs in batches of 100, retrying a failed
// batch one ID at a time so valid IDs still transfer and per-ID failures pinpoint
// the bad ones. Only IDs that actually got the new owner are returned. When
// removeOldOwner is supplied, it strips the previous owner from each successfully
// reassigned batch. Shared by the bulk-owner content types (app-studio, page,
// worksheet, group) whose owner endpoints otherwise take the whole list at once.
async function reassignOwnersInBatches(ids, { label, addOwner, removeOldOwner }) {
	const batchSize = 100;
	const transferred = [];
	for (let i = 0; i < ids.length; i += batchSize) {
		const chunk = ids.slice(i, i + batchSize);
		const bulk = await attempt(`reassign ${label}s ${i + 1}-${i + chunk.length}`, () => addOwner(chunk), { ids: chunk });
		if (bulk.ok) {
			transferred.push(...chunk);
		} else {
			console.log(`  Batch ${i + 1}-${i + chunk.length} failed — retrying ${chunk.length} ${label}(s) individually...`);
			for (const id of chunk) {
				const one = await attempt(`reassign ${label} ${id}`, () => addOwner([id]), { ids: [id] });
				if (one.ok) transferred.push(id);
			}
		}
	}
	if (transferred.length < ids.length) {
		console.log(`  ${label}s reassigned: ${transferred.length}/${ids.length}`);
	}
	if (removeOldOwner && transferred.length > 0) {
		for (let i = 0; i < transferred.length; i += batchSize) {
			const chunk = transferred.slice(i, i + batchSize);
			await safe(`remove previous ${label} owner ${i + 1}-${i + chunk.length}`, () => removeOldOwner(chunk), {
				ids: chunk
			});
		}
	}
	return transferred;
}

async function reportPublications(fromUserId, _toUserId, filteredIds) {
	const ids = filteredIds.length > 0 ? filteredIds : await listPublications(fromUserId);
	if (ids.length > 0) {
		console.warn(`  (publications cannot be transferred via API; ${ids.length} found but left untouched)`);
	}
	return { transferred: [], notTransferred: ids };
}

async function resourceExists(type, id) {
	try {
		if (type === 'CARD') {
			await api.get(`/content/v1/cards/${id}/details`);
			return true;
		}
		if (type === 'DATA_SOURCE' || type === 'DATASET') {
			await api.get(`/data/v3/datasources/${id}`);
			return true;
		}
		return true;
	} catch (_e) {
		return false;
	}
}

async function runType(type, ids, ctx) {
	console.log(`\n=== ${type} ===`);
	activeType = type;
	const { fromUserId, toUserId } = ctx;
	const handler = HANDLERS[type];
	if (!handler) {
		console.warn(`Unknown type: ${type}`);
		return { transferred: [] };
	}
	return handler(fromUserId, toUserId, ids, ctx);
}

async function safe(label, fn, context) {
	const { value } = await attempt(label, fn, context);
	return value;
}

async function sanitizeLinks(links) {
	if (!Array.isArray(links) || links.length === 0) return { valid: [], invalid: [] };
	const valid = [];
	const invalid = [];
	for (const link of links) {
		const res = link && link.resource ? link.resource : null;
		if (res && res.id != null && (res.type === 'CARD' || res.type === 'DATA_SOURCE' || res.type === 'DATASET')) {
			const exists = await resourceExists(res.type, res.id);
			if (!exists) {
				invalid.push(link);
				continue;
			}
		}
		valid.push(link);
	}
	return { valid, invalid };
}

// Email the new owner a summary of everything that was transferred to them.
// Uses Domo's social messaging endpoint (mirrors domo-toolkit's messages
// service): POST /social/v3/messages/domoWrapperNew:plainText/send with the
// recipient routed both by email (query param) and user ID (body), so it lands
// even if the email lookup fails. The HTML body is wrapped in the same
// Helvetica flex-column styling the toolkit/Code Engine helpers use.
async function sendTransferEmail({ toUserId, toUserName, fromUserName, transferredByType }) {
	const types = Object.entries(transferredByType).filter(([, ids]) => ids && ids.length > 0);
	if (types.length === 0) {
		console.log('  Nothing was transferred — skipping email.');
		return;
	}

	const total = types.reduce((sum, [, ids]) => sum + ids.length, 0);
	const email = await getUserEmail(toUserId);

	const fromClause = fromUserName ? ` previously owned by ${escapeHtml(fromUserName)}` : '';
	let bodyHtml = `<h2 style="text-align: left;">Content transferred to you</h2>`;
	bodyHtml += `<p style="text-align: left;">Hi ${escapeHtml(toUserName)},</p>`;
	bodyHtml += `<p style="text-align: left;">You are now the owner of ${total} item(s)${fromClause}, broken down below.</p>`;
	for (const [type, ids] of types) {
		bodyHtml += `<h3 style="text-align: left;">${escapeHtml(type)} (${ids.length})</h3>`;
		bodyHtml += `<ul style="text-align: left;">${ids.map((id) => `<li>${escapeHtml(id)}</li>`).join('')}</ul>`;
	}

	const payload = {
		subject: 'Domo content transferred to you',
		text: `<div style="display: flex; flex-direction: column; font-family: Helvetica; overflow-x: auto; flex-wrap: wrap; width: 100%; text-align: center;"><div style="display: flex; flex-direction: column; justify-content: center; width: 100%">${bodyHtml}</div></div>`,
		recipientsUserIds: [parseInt(toUserId, 10)],
		recipientsGroupIds: [],
		dataFileAttachments: [],
		populateReplyToHeaderWithRecipients: false
	};

	const url = `/social/v3/messages/domoWrapperNew:plainText/send?route=recipients&method=EMAIL&recipients=${encodeURIComponent(
		email || ''
	)}`;
	// safe() logs and records any failure (into `failures`) and returns null, so
	// only announce success when nothing was recorded for this send.
	await safe('send transfer email', () => api.post(url, { parameters: payload }), { toUserId, recipientEmail: email });
	if (!failures.some((f) => f.label === 'send transfer email')) {
		console.log(`  → Emailed ${toUserName}${email ? ` (${email})` : ''} a summary of ${total} transferred item(s).`);
	}
}

async function transferAccounts(fromUserId, toUserId, filteredIds, { dryRun }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const count = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`search accounts offset=${offset}`, () =>
				api.post('/search/v1/query', {
					count,
					offset,
					combineResults: false,
					hideSearchObjects: true,
					query: '**',
					filters: [
						{
							filterType: 'term',
							field: 'owned_by_id',
							value: fromUserId,
							name: 'Owned by',
							not: false
						}
					],
					facetValuesToInclude: [],
					queryProfile: 'GLOBAL',
					entityList: [['account']]
				})
			);
			const accounts = res && res.searchResultsMap && res.searchResultsMap.account;
			if (!accounts || accounts.length === 0) break;
			ids.push(...accounts.map((a) => a.databaseId));
			if (accounts.length < count) break;
			offset += count;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const res = await attempt(`reassign account ${id}`, () =>
			api.put(`/data/v2/accounts/share/${id}`, {
				type: 'USER',
				id: toUserId,
				accessLevel: 'OWNER'
			})
		);
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferAiModels(fromUserId, toUserId, filteredIds, { dryRun }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const limit = 50;
		let offset = 0;
		while (true) {
			const res = await safe(`search ai models offset=${offset}`, () =>
				api.post('/datascience/ml/v1/search/models', {
					limit,
					offset,
					sortFieldMap: { CREATED: 'DESC' },
					searchFieldMap: { NAME: '' },
					filters: [{ type: 'OWNER', values: [fromUserId] }],
					metricFilters: {},
					dateFilters: {},
					sortMetricMap: {}
				})
			);
			if (!res || !res.models || res.models.length === 0) break;
			ids.push(...res.models.map((m) => m.id));
			if (res.models.length < limit) break;
			offset += limit;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const res = await attempt(`reassign ai model ${id}`, () =>
			api.post(`/datascience/ml/v1/models/${id}/ownership`, { userId: toUserId })
		);
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferAiProjects(fromUserId, toUserId, filteredIds, { dryRun }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const limit = 50;
		let offset = 0;
		while (true) {
			const res = await safe(`search ai projects offset=${offset}`, () =>
				api.post('/datascience/ml/v1/search/projects', {
					limit,
					offset,
					sortFieldMap: { CREATED: 'DESC' },
					searchFieldMap: { NAME: '' },
					filters: [{ type: 'OWNER', values: [fromUserId] }],
					metricFilters: {},
					dateFilters: {},
					sortMetricMap: {}
				})
			);
			if (!res || !res.projects || res.projects.length === 0) break;
			ids.push(...res.projects.map((p) => p.id));
			if (res.projects.length < limit) break;
			offset += limit;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const res = await attempt(`reassign ai project ${id}`, () =>
			api.post(`/datascience/ml/v1/projects/${id}/ownership`, { userId: toUserId })
		);
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferAlerts(fromUserId, toUserId, filteredIds, { dryRun }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const limit = 50;
		let offset = 0;
		while (true) {
			const res = await safe(`list alerts offset=${offset}`, () =>
				api.get(`/social/v4/alerts?ownerId=${fromUserId}&limit=${limit}&offset=${offset}`)
			);
			if (!res || res.length === 0) break;
			ids.push(...res.map((a) => a.id));
			if (res.length < limit) break;
			offset += limit;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const res = await attempt(`update alert ${id}`, () =>
			api.request('PATCH', `/social/v4/alerts/${id}`, { id, owner: toUserId })
		);
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferAppDbCollections(fromUserId, toUserId, filteredIds, { dryRun }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const pageSize = 100;
		let pageNumber = 1;
		while (true) {
			const res = await safe(`search collections page=${pageNumber}`, () =>
				api.post('/datastores/v1/collections/query', {
					collectionFilteringList: [
						{
							filterType: 'ownedby',
							comparingCriteria: 'equals',
							typedValue: fromUserId
						}
					],
					pageSize,
					pageNumber
				})
			);
			if (!res || !res.collections || res.collections.length === 0) break;
			ids.push(...res.collections.map((c) => c.id));
			if (res.collections.length < pageSize) break;
			pageNumber += 1;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const res = await attempt(`update collection ${id}`, () =>
			api.put(`/datastores/v1/collections/${id}`, { id, owner: toUserId })
		);
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferApprovals(fromUserId, toUserId, filteredIds, { dryRun }) {
	if (filteredIds.length > 0) {
		console.warn('  (approvals only support discovery from --from-user; ignoring filtered IDs)');
	}
	const url = '/synapse/approval/graphql';
	const searchBody = {
		operationName: 'getFilteredRequests',
		variables: {
			query: {
				active: true,
				submitterId: null,
				approverId: fromUserId,
				templateId: null,
				title: null,
				lastModifiedBefore: null
			},
			after: null,
			reverseSort: false
		},
		query:
			'query getFilteredRequests($query: QueryRequest!, $after: ID, $reverseSort: Boolean) {\n  workflowSearch(query: $query, type: "AC", after: $after, reverseSort: $reverseSort) {\n    edges {\n      node {\n        approval {\n          id\n          status\n          version\n        }\n      }\n    }\n  }\n}\n'
	};

	const res = await safe('search approvals', () => api.post(url, searchBody));
	const edges = (res && res.data && res.data.workflowSearch && res.data.workflowSearch.edges) || [];
	const pending = edges.filter((e) => e.node.approval.status === 'PENDING');
	const sentBack = edges.filter((e) => e.node.approval.status === 'SENTBACK');

	if (pending.length === 0) {
		return { transferred: [], notTransferred: sentBack.map((s) => s.node.approval.id) };
	}
	if (dryRun) {
		return {
			transferred: pending.map((p) => p.node.approval.id),
			notTransferred: sentBack.map((s) => s.node.approval.id)
		};
	}

	for (const edge of pending) {
		const { id, version } = edge.node.approval;
		await safe(`replace approver on ${id}`, () =>
			api.post(url, {
				operationName: 'replaceApprovers',
				variables: {
					actedOnApprovals: [{ id, version }],
					newApproverId: toUserId,
					newApproverType: 'PERSON'
				},
				query:
					'mutation replaceApprovers($actedOnApprovals: [ActedOnApprovalInput!]!, $newApproverId: ID!, $newApproverType: ApproverType) {\n  bulkReplaceApprover(actedOnApprovals: $actedOnApprovals, newApproverId: $newApproverId, newApproverType: $newApproverType) {\n    id\n  }\n}\n'
			})
		);
	}
	return {
		transferred: pending.map((p) => p.node.approval.id),
		notTransferred: sentBack.map((s) => s.node.approval.id)
	};
}

async function transferApprovalTemplates(fromUserId, toUserId, filteredIds, { dryRun }) {
	if (filteredIds.length > 0) {
		console.warn('  (approval templates only support discovery from --from-user; ignoring filtered IDs)');
	}
	const url = '/synapse/approval/graphql';

	const searchBody = {
		operationName: 'getFilteredTemplates',
		variables: {
			first: 100,
			after: null,
			orderBy: 'TEMPLATE',
			reverseSort: false,
			query: {
				type: 'AC',
				searchTerm: '',
				category: [],
				ownerId: fromUserId,
				publishedOnly: false
			}
		},
		query:
			'query getFilteredTemplates($first: Int, $after: ID, $orderBy: OrderBy, $reverseSort: Boolean, $query: TemplateQueryRequest!) { templateConnection(first: $first, after: $after, orderBy: $orderBy, reverseSort: $reverseSort, query: $query) { edges { node { id } } } }'
	};

	const search = await safe('search approval templates', () => api.post(url, searchBody));
	const edges = (search && search.data && search.data.templateConnection && search.data.templateConnection.edges) || [];
	if (edges.length === 0) return { transferred: [] };

	const templateIds = edges.map((e) => e.node.id);
	if (dryRun) return { transferred: templateIds };

	const getTemplateQuery =
		'query getTemplateForEdit($id: ID!) {\n  template(id: $id) {\n    id\n    title\n    titleName\n    titlePlaceholder\n    acknowledgment\n    instructions\n    description\n    providerName\n    isPublic\n    chainIsLocked\n    type\n    isPublished\n    observers { id type ... on Group { userCount isDeleted } ... on User { isDeleted } }\n    categories { id name }\n    owner { id }\n    fields { key type name data placeholder required isPrivate ... on SelectField { option multiselect datasource column order } }\n    approvers { type key ... on ApproverPerson { approverId userDetails { id isDeleted } } ... on ApproverGroup { approverId groupDetails { id isDeleted } } ... on ApproverPlaceholder { placeholderText } }\n    workflowIntegration { modelId modelVersion startName modelName parameterMapping { fields { field parameter required type } } }\n  }\n}';

	const saveTemplateMutation =
		'mutation saveTemplate($template: TemplateInput!) { template: saveTemplate(template: $template) { id } }';

	for (const id of templateIds) {
		const res = await safe(`get template ${id}`, () =>
			api.post(url, {
				operationName: 'getTemplateForEdit',
				variables: { id },
				query: getTemplateQuery
			})
		);
		const raw = res && res.data && res.data.template;
		if (!raw) continue;

		const activeApprovers = (raw.approvers || []).filter(
			(a) =>
				!(a.type === 'PERSON' && a.userDetails && a.userDetails.isDeleted) &&
				!(a.type === 'GROUP' && a.groupDetails && a.groupDetails.isDeleted)
		);
		let approvers = activeApprovers.map((a) =>
			a.type === 'PERSON' && a.approverId == fromUserId
				? { approverId: toUserId, type: 'PERSON', key: a.key }
				: {
						type: a.type,
						key: a.key,
						...(a.approverId && { approverId: a.approverId }),
						...(a.placeholderText && { placeholderText: a.placeholderText })
					}
		);
		approvers = approvers.filter(
			(v, i, self) => !v.approverId || i === self.findIndex((x) => x.approverId === v.approverId)
		);
		if (approvers.length === 0) {
			approvers.push({ approverId: toUserId, type: 'PERSON', key: '0' });
		}

		let observers = (raw.observers || []).map((o) => ({
			id: o.id == fromUserId ? toUserId : o.id,
			type: o.type,
			...(o.type === 'Group' && o.userCount !== undefined && { userCount: o.userCount })
		}));
		observers = observers.filter((v, i, self) => i === self.findIndex((x) => x.id === v.id));
		const deletedObserverIds = new Set((raw.observers || []).filter((o) => o.isDeleted).map((o) => o.id));
		observers = observers.filter((o) => !deletedObserverIds.has(o.id));

		const clean = {
			id: raw.id,
			title: raw.title,
			titleName: raw.titleName,
			titlePlaceholder: raw.titlePlaceholder,
			acknowledgment: raw.acknowledgment,
			instructions: raw.instructions,
			description: raw.description,
			providerName: raw.providerName,
			isPublic: raw.isPublic,
			chainIsLocked: raw.chainIsLocked,
			type: raw.type,
			isPublished: raw.isPublished,
			ownerId: toUserId,
			fields: (raw.fields || []).map((f) => ({
				key: f.key,
				type: f.type,
				name: f.name,
				placeholder: f.placeholder,
				required: f.required,
				isPrivate: f.isPrivate,
				...(f.data !== undefined && { data: f.data }),
				...(f.option !== undefined && { option: f.option }),
				...(f.multiselect !== undefined && { multiselect: f.multiselect }),
				...(f.datasource !== undefined && { datasource: f.datasource }),
				...(f.column !== undefined && { column: f.column }),
				...(f.order !== undefined && { order: f.order })
			})),
			approvers,
			observers,
			categories: (raw.categories || []).map((c) => ({ id: c.id, name: c.name }))
		};
		if (raw.workflowIntegration) {
			clean.workflowIntegration = {
				modelId: raw.workflowIntegration.modelId,
				modelVersion: raw.workflowIntegration.modelVersion,
				startName: raw.workflowIntegration.startName,
				modelName: raw.workflowIntegration.modelName
			};
			if (raw.workflowIntegration.parameterMapping) {
				clean.workflowIntegration.parameterMapping = {
					fields: (raw.workflowIntegration.parameterMapping.fields || []).map((f) => ({
						field: f.field,
						parameter: f.parameter,
						required: f.required,
						type: f.type
					}))
				};
			}
		}

		await safe(`save template ${id}`, () =>
			api.post(url, {
				operationName: 'saveTemplate',
				variables: { template: clean },
				query: saveTemplateMutation
			})
		);
	}
	return { transferred: templateIds };
}

async function transferAppStudioApps(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner }) {
	let ids = filteredIds.map(String);
	if (ids.length === 0) {
		const limit = 30;
		let skip = 0;
		while (true) {
			const res = await safe(`list app studio apps skip=${skip}`, () =>
				api.post(`/content/v1/dataapps/adminsummary?limit=${limit}&skip=${skip}`, {
					ascending: true,
					includeOwnerClause: true,
					includeTitleClause: true,
					orderBy: 'title',
					ownerIds: [fromUserId],
					titleSearchText: '',
					type: 'app'
				})
			);
			const summaries = res && res.dataAppAdminSummaries;
			if (!summaries || summaries.length === 0) break;
			ids.push(...summaries.map((s) => String(s.dataAppId)));
			if (summaries.length < limit) break;
			skip += limit;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = await reassignOwnersInBatches(ids, {
		label: 'app studio app',
		addOwner: (entityIds) =>
			api.put('/content/v1/dataapps/bulk/owners', {
				note: '',
				entityIds,
				owners: [{ type: 'USER', id: parseInt(toUserId, 10) }],
				sendEmail: false
			}),
		removeOldOwner:
			fromUserId && !keepPreviousOwner
				? (entityIds) =>
						api.post('/content/v1/dataapps/bulk/owners/remove', {
							entityIds,
							owners: [{ type: 'USER', id: fromUserId }]
						})
				: null
	});
	return { transferred };
}

async function transferCards(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const count = 50;
		let offset = 0;
		while (true) {
			const res = await safe(`search cards offset=${offset}`, () =>
				api.post('/search/v1/query', {
					count,
					offset,
					combineResults: false,
					query: '*',
					filters: [
						{
							name: 'OWNED_BY_ID',
							field: 'owned_by_id',
							facetType: 'user',
							value: `${fromUserId}:USER`,
							filterType: 'term'
						}
					],
					entityList: [['card']]
				})
			);
			if (!res || !res.searchObjects || res.searchObjects.length === 0) break;
			ids.push(...res.searchObjects.map((c) => c.databaseId));
			if (res.searchObjects.length < count) break;
			offset += count;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	// POST /content/v1/cards/owners/{action} — action is "add" or "remove";
	// same body shape for both. Cards support multiple owners, so adding the new
	// owner only makes them a co-owner; the old owner is removed separately below.
	const updateOwners = (action, cardIds, ownerId) =>
		api.post(`/content/v1/cards/owners/${action}`, {
			cardIds,
			cardOwners: [{ id: ownerId, type: 'USER' }],
			note: '',
			sendEmail: false
		});

	// Cards allow multiple owners, so adding the new owner only makes them a
	// co-owner; the previous owner is removed afterward from the cards that
	// successfully got the new owner — unless --keep-previous-owner (or no
	// --from-user), in which case the old owner stays attached.
	const transferred = await reassignOwnersInBatches(ids, {
		label: 'card',
		addOwner: (cardIds) => updateOwners('add', cardIds, toUserId),
		removeOldOwner: fromUserId && !keepPreviousOwner ? (cardIds) => updateOwners('remove', cardIds, fromUserId) : null
	});
	return { transferred };
}

async function transferCodeEnginePackages(fromUserId, toUserId, filteredIds, { dryRun }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const count = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`search packages offset=${offset}`, () =>
				api.post('/search/v1/query', {
					query: '**',
					entityList: [['package']],
					count,
					offset,
					filters: [
						{
							field: 'owned_by_id',
							filterType: 'term',
							value: `${fromUserId}:USER`
						}
					],
					hideSearchObjects: true,
					facetValuesToInclude: []
				})
			);
			const pkgs = res && res.searchResultsMap && res.searchResultsMap.package;
			if (!pkgs || pkgs.length === 0) break;
			ids.push(...pkgs.map((p) => p.uuid));
			if (pkgs.length < count) break;
			offset += count;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const res = await attempt(`reassign package ${id}`, () =>
			api.put(`/codeengine/v2/packages/${id}`, {
				owner: parseInt(toUserId, 10)
			})
		);
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferCustomApps(fromUserId, toUserId, filteredIds, { dryRun }) {
	const bricks = [];
	const proCodeApps = [];
	const ownedByUser = [];

	const classify = (appSummary) => {
		if (fromUserId && appSummary.owner != fromUserId) return;
		const versions = appSummary.versions;
		const flags = versions && versions[0] && versions[0].flags;
		const clientCodeEnabled = flags && flags['client-code-enabled'];
		if (clientCodeEnabled) bricks.push(appSummary.id);
		else proCodeApps.push(appSummary.id);
		ownedByUser.push(appSummary.id);
	};

	if (filteredIds.length > 0) {
		for (const appId of filteredIds) {
			const app = await safe(`get app ${appId}`, () => api.get(`/apps/v1/designs/${appId}?parts=versions`));
			if (app) classify({ ...app, id: appId });
		}
	} else {
		const limit = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`list apps offset=${offset}`, () =>
				api.get(`/apps/v1/designs?checkAdminAuthority=true&deleted=false&limit=${limit}&offset=${offset}`)
			);
			if (!res || res.length === 0) break;
			for (const app of res) classify(app);
			if (res.length < limit) break;
			offset += limit;
		}
	}

	if (ownedByUser.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ownedByUser, bricks, proCodeApps };

	const transferred = [];
	for (const id of ownedByUser) {
		const res = await attempt(`grant admin to new owner on app ${id}`, () =>
			api.post(`/apps/v1/designs/${id}/permissions/ADMIN`, [toUserId])
		);
		if (res.ok) transferred.push(id);
	}
	return { transferred, bricks, proCodeApps };
}

async function transferDataflows(fromUserId, toUserId, filteredIds, { dryRun, fromUserName, inputAccessLevel }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const pageSize = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`search dataflows offset=${offset}`, () =>
				api.post('/search/v1/query', {
					entities: ['DATAFLOW'],
					filters: [{ field: 'owned_by_id', filterType: 'term', value: fromUserId }],
					query: '*',
					count: pageSize,
					offset
				})
			);
			if (!res || !res.searchObjects || res.searchObjects.length === 0) break;
			ids.push(...res.searchObjects.map((o) => o.databaseId));
			if (res.searchObjects.length < pageSize) break;
			offset += pageSize;
		}
	}
	if (ids.length === 0) return { transferred: [] };

	// Resolve the source name(s) for tagging before reassignment overwrites the owner.
	const tagNameById = dryRun ? {} : await captureDataflowOwnerNames(ids, fromUserName);

	if (dryRun) {
		const inputAccess = await ensureDataflowInputAccess(ids, toUserId, { dryRun, inputAccessLevel });
		return { transferred: ids, inputAccess };
	}

	const reassignBulk = (dataFlowIds) =>
		api.put('/dataprocessing/v1/dataflows/bulk/patch', {
			dataFlowIds,
			responsibleUserId: toUserId
		});
	const reassignOne = (id) =>
		api.put(`/dataprocessing/v1/dataflows/${id}/patch`, {
			responsibleUserId: toUserId
		});

	// Try the whole set in one bulk patch first. If that fails, retry each
	// dataflow on its own via the per-dataflow endpoint — a different code path
	// that can succeed where the bulk call choked, and the per-ID failures
	// pinpoint exactly which dataflows are the problem.
	let transferred = ids;
	const bulk = await attempt('reassign dataflows', () => reassignBulk(ids), { dataFlowIds: ids });
	if (!bulk.ok) {
		console.log(`  Bulk reassign failed — retrying ${ids.length} dataflow(s) individually...`);
		transferred = [];
		for (const id of ids) {
			const one = await attempt(`reassign dataflow ${id}`, () => reassignOne(id), { dataFlowId: id });
			if (one.ok) transferred.push(id);
		}
		console.log(`  Individual retry: ${transferred.length}/${ids.length} succeeded`);
	}

	if (transferred.length > 0) {
		const batchSize = 50;
		const tagGroups = groupByTagName(transferred, tagNameById);
		for (const [name, groupIds] of tagGroups) {
			for (let i = 0; i < groupIds.length; i += batchSize) {
				const chunk = groupIds.slice(i, i + batchSize);
				await safe(
					`tag dataflows (From ${name}) ${i + 1}-${i + chunk.length}`,
					() =>
						api.put('/dataprocessing/v1/dataflows/bulk/tag', {
							dataFlowIds: chunk,
							tagNames: [`From ${name}`]
						}),
					{ dataFlowIds: chunk }
				);
			}
		}
	}

	// Make sure the new owner can read each transferred dataflow's input datasets;
	// share any they can't already reach (directly or via group membership).
	const inputAccess =
		transferred.length > 0
			? await ensureDataflowInputAccess(transferred, toUserId, { dryRun, inputAccessLevel })
			: { shared: [], alreadyHadAccess: [] };
	return { transferred, inputAccess };
}

async function transferDatasets(fromUserId, toUserId, filteredIds, { dryRun, fromUserName }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const res = await safe('list datasets owned by user', () =>
			api.post('/data/ui/v3/datasources/ownedBy', [{ id: String(fromUserId), type: 'USER' }])
		);
		if (res && res[0] && Array.isArray(res[0].dataSourceIds)) {
			ids = res[0].dataSourceIds;
		}
	}
	if (ids.length === 0) return { transferred: [] };

	// Resolve the source name(s) for tagging before reassignment overwrites the owner.
	const tagNameById = dryRun ? {} : await captureDatasetOwnerNames(ids, fromUserName);

	if (dryRun) return { transferred: ids };

	const reassignBatch = (dsIds) =>
		api.put('/data/ui/v3/datasources/ownedBy', [
			{
				entityIdentifier: { id: parseInt(toUserId, 10), type: 'USER' },
				dataSourceIds: dsIds
			}
		]);
	const reassignOne = (id) =>
		api.put(`/data/v2/datasources/${id}/responsibleUsers`, {
			responsibleUserId: String(toUserId)
		});

	// Reassign in batches. When a batch fails, retry each dataset on its own via
	// the per-dataset endpoint — a different code path that can succeed where the
	// batch choked, and the per-ID failures pinpoint which datasets are the
	// problem. transferred tracks only what actually went through, so the count
	// and tagging stay honest.
	const batchSize = 50;
	const transferred = [];
	for (let i = 0; i < ids.length; i += batchSize) {
		const chunk = ids.slice(i, i + batchSize);
		const bulk = await attempt(`reassign datasets ${i + 1}-${i + chunk.length}`, () => reassignBatch(chunk), {
			ids: chunk
		});
		if (bulk.ok) {
			transferred.push(...chunk);
		} else {
			console.log(`  Batch ${i + 1}-${i + chunk.length} failed — retrying ${chunk.length} dataset(s) individually...`);
			for (const id of chunk) {
				const one = await attempt(`reassign dataset ${id}`, () => reassignOne(id), { id });
				if (one.ok) transferred.push(id);
			}
		}
	}
	if (transferred.length < ids.length) {
		console.log(`  Datasets reassigned: ${transferred.length}/${ids.length}`);
	}

	if (transferred.length > 0) {
		const tagGroups = groupByTagName(transferred, tagNameById);
		for (const [name, groupIds] of tagGroups) {
			for (let i = 0; i < groupIds.length; i += batchSize) {
				const chunk = groupIds.slice(i, i + batchSize);
				await safe(
					`tag datasets (From ${name}) ${i + 1}-${i + chunk.length}`,
					() =>
						api.post('/data/v1/ui/bulk/tag', {
							bulkItems: { ids: chunk, type: 'DATA_SOURCE' },
							tags: [`From ${name}`]
						}),
					{ ids: chunk }
				);
			}
		}
	}
	return { transferred };
}

async function transferFilesets(fromUserId, toUserId, filteredIds, { dryRun }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const limit = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`search filesets offset=${offset}`, () =>
				api.post(`/files/v1/filesets/search?offset=${offset}&limit=${limit}`, {
					filters: [{ field: 'owner', value: [fromUserId], not: false, operator: 'EQUALS' }],
					fieldSort: [{ field: 'updated', order: 'DESC' }],
					dateFilters: []
				})
			);
			if (!res || !res.filesets || res.filesets.length === 0) break;
			ids.push(...res.filesets.map((f) => f.id));
			if (res.filesets.length < limit) break;
			offset += limit;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const res = await attempt(`reassign fileset ${id}`, () =>
			api.post(`/files/v1/filesets/${id}/ownership`, {
				userId: parseInt(toUserId, 10)
			})
		);
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

// Run the full per-type transfer for a single destination user. Called once per
// group of work — when --to-user-column partitions a CSV across several new
// owners, this runs once per owner. Per-type counts accumulate into the shared
// `summary`; returns the type → transferred-IDs map for the optional email.
// Per-type errors are sliced out of the global `failures` array by position
// (not filtered by type) so a type processed for multiple owners attributes
// only that owner's failures to that owner's log entry.
async function transferForUser({ ctx, objectsByType, requestedTypes, logger, summary }) {
	const { fromUserId, toUserId } = ctx;
	const typesToProcess = objectsByType ? Object.keys(objectsByType) : requestedTypes || ALL_TYPES;
	const transferredByType = {};

	const addTotal = (type, n) => {
		summary.totals[type] = (summary.totals[type] || 0) + n;
	};

	for (const type of typesToProcess) {
		const filtered = objectsByType ? objectsByType[type] || [] : [];

		if (objectsByType && filtered.length === 0) continue;
		if (objectsByType && DISCOVERY_ONLY_TYPES.has(type)) {
			console.log(`\n=== ${type} ===`);
			console.warn(
				`  Type "${type}" only supports discovery from --from-user; skipping ${filtered.length} filtered ID(s).`
			);
			summary.skipped.push({ type, ids: filtered, reason: 'discovery-only' });
			continue;
		}

		if (COALESCED_TYPES.has(type)) continue; // handled below

		const errStart = failures.length;
		try {
			const res = await runType(type, filtered, ctx);
			const transferred = (res && res.transferred) || [];
			addTotal(type, transferred.length);
			if (transferred.length) transferredByType[type] = transferred;
			const typeErrors = failures.slice(errStart);
			logger.addResult({ type, toUserId, transferred, errors: typeErrors, details: res });
			if (typeErrors.length) console.log(`  ⚠ ${typeErrors.length} error(s) logged — see run log`);
			console.log(`  → ${transferred.length} transferred`);
		} catch (err) {
			console.error(`  ✗ ${type} failed: ${err.message}`);
			addTotal(type, 0);
			logger.addResult({ type, toUserId, error: err.message, errors: failures.slice(errStart) });
		}
	}

	// Beast modes + variables share transferFunctions — call it once.
	const beastSelected = typesToProcess.includes('beast-mode');
	const varSelected = typesToProcess.includes('variable');
	if (beastSelected || varSelected) {
		console.log(`\n=== beast-mode / variable ===`);
		activeType = 'beast-mode/variable';
		const errStart = failures.length;
		const combinedIds = [
			...((objectsByType && objectsByType['beast-mode']) || []),
			...((objectsByType && objectsByType['variable']) || [])
		];
		try {
			const res = await transferFunctions(fromUserId, toUserId, combinedIds, ctx);
			const coalescedErrors = failures.slice(errStart);
			if (beastSelected) {
				addTotal('beast-mode', (res.beastModes || []).length);
				if ((res.beastModes || []).length) transferredByType['beast-mode'] = res.beastModes;
				logger.addResult({
					type: 'beast-mode',
					toUserId,
					transferred: res.beastModes,
					errors: coalescedErrors,
					details: { deleted: res.deletedBeastModes }
				});
				console.log(`  → ${(res.beastModes || []).length} beast modes transferred`);
			}
			if (varSelected) {
				addTotal('variable', (res.variables || []).length);
				if ((res.variables || []).length) transferredByType['variable'] = res.variables;
				logger.addResult({
					type: 'variable',
					toUserId,
					transferred: res.variables,
					errors: coalescedErrors,
					details: { deleted: res.deletedVariables }
				});
				console.log(`  → ${(res.variables || []).length} variables transferred`);
			}
			if (coalescedErrors.length) console.log(`  ⚠ ${coalescedErrors.length} error(s) logged — see run log`);
		} catch (err) {
			console.error(`  ✗ beast-mode/variable failed: ${err.message}`);
		}
	}

	// Projects + project-tasks share a single API flow; handle them together.
	const projectsSelected = typesToProcess.includes('project');
	const taskSelected = typesToProcess.includes('project-task');
	if (projectsSelected || taskSelected) {
		console.log(`\n=== project / project-task ===`);
		activeType = 'project/project-task';
		const errStart = failures.length;
		const projectIds = (objectsByType && objectsByType['project']) || [];
		const taskIds = (objectsByType && objectsByType['project-task']) || [];
		try {
			const res = await transferProjectsAndTasks(fromUserId, toUserId, projectIds, taskIds, ctx);
			const coalescedErrors = failures.slice(errStart);
			if (projectsSelected) {
				addTotal('project', (res.projects || []).length);
				if ((res.projects || []).length) transferredByType['project'] = res.projects;
				logger.addResult({ type: 'project', toUserId, transferred: res.projects, errors: coalescedErrors, details: res });
				console.log(`  → ${(res.projects || []).length} projects transferred`);
			}
			if (taskSelected) {
				addTotal('project-task', (res.tasks || []).length);
				if ((res.tasks || []).length) transferredByType['project-task'] = res.tasks;
				logger.addResult({ type: 'project-task', toUserId, transferred: res.tasks, errors: coalescedErrors, details: res });
				console.log(`  → ${(res.tasks || []).length} tasks transferred`);
			}
			if (coalescedErrors.length) console.log(`  ⚠ ${coalescedErrors.length} error(s) logged — see run log`);
		} catch (err) {
			console.error(`  ✗ projects/tasks failed: ${err.message}`);
		}
	}

	return transferredByType;
}

async function transferFunctions(fromUserId, toUserId, filteredIds, { dryRun }) {
	const bulkUrl = '/query/v1/functions/bulk/template';
	const transferred = { beastMode: [], variable: [] };
	const deleted = { beastMode: [], variable: [] };

	const handleTemplate = async (template) => {
		const result = await processFunctionTemplate(template, toUserId);
		const bucket = result.global === false ? 'beastMode' : 'variable';
		if (result.deleted) deleted[bucket].push(template.id);
		else return { bucket, update: result.update };
		return null;
	};

	if (filteredIds.length > 0) {
		if (dryRun) return { transferred: filteredIds };
		const updates = { beastMode: [], variable: [] };
		for (const fid of filteredIds) {
			const template = await safe(`get function ${fid}`, () =>
				api.get(`/query/v1/functions/template/${fid}?hidden=true`)
			);
			if (!template) continue;
			const out = await handleTemplate(template);
			if (out) updates[out.bucket].push(out.update);
		}
		for (const bucket of ['beastMode', 'variable']) {
			for (let i = 0; i < updates[bucket].length; i += 100) {
				const chunk = updates[bucket].slice(i, i + 100);
				await safe(`bulk update ${bucket} ${i + 1}-${i + chunk.length}`, () => api.post(bulkUrl, { update: chunk }), {
					ids: chunk.map((u) => u.id)
				});
			}
			transferred[bucket].push(...updates[bucket].map((u) => u.id));
		}
	} else {
		const limit = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`search functions offset=${offset}`, () =>
				api.post('/query/v1/functions/search', {
					filters: [{ field: 'owner', idList: [fromUserId] }],
					sort: { field: 'name', ascending: true },
					limit,
					offset
				})
			);
			if (!res || !res.results || res.results.length === 0) break;
			if (!dryRun) {
				const updates = { beastMode: [], variable: [] };
				for (const template of res.results) {
					const out = await handleTemplate(template);
					if (out) updates[out.bucket].push(out.update);
				}
				for (const bucket of ['beastMode', 'variable']) {
					for (let i = 0; i < updates[bucket].length; i += 100) {
						const chunk = updates[bucket].slice(i, i + 100);
						await safe(
							`bulk update ${bucket} ${i + 1}-${i + chunk.length}`,
							() => api.post(bulkUrl, { update: chunk }),
							{ ids: chunk.map((u) => u.id) }
						);
					}
					transferred[bucket].push(...updates[bucket].map((u) => u.id));
				}
			} else {
				for (const template of res.results) {
					const bucket = template.global === false ? 'beastMode' : 'variable';
					transferred[bucket].push(template.id);
				}
			}
			offset += limit;
			if (!res.hasMore) break;
		}
	}

	return {
		transferred: [...transferred.beastMode, ...transferred.variable],
		deletedBeastModes: deleted.beastMode,
		deletedVariables: deleted.variable,
		beastModes: transferred.beastMode,
		variables: transferred.variable
	};
}

async function transferGoals(fromUserId, toUserId, filteredIds, { dryRun }) {
	if (filteredIds.length > 0) {
		console.warn('  (goal transfer only supports discovery from --from-user; ignoring filtered IDs)');
	}
	const period = await safe('get current goal period', () => api.get('/social/v1/objectives/periods?all=true'));
	const current = (period || []).find((p) => p.current);
	if (!current) return { transferred: [] };

	const data = await safe('get user goals', () =>
		api.get(
			`/social/v2/objectives/profile?filterKeyResults=false&includeSampleGoal=false&periodId=${current.id}&ownerId=${fromUserId}`
		)
	);
	if (!data) return { transferred: [] };

	const seen = new Set();
	const allGoals = [];
	const collect = (arr) => {
		if (!Array.isArray(arr)) return;
		for (const g of arr) {
			if (g.id != null && !seen.has(g.id)) {
				seen.add(g.id);
				allGoals.push(g);
			}
		}
	};
	collect(data.assigned);
	collect(data.company);
	collect(data.contributing);
	collect(data.personal);
	if (data.team && typeof data.team === 'object') {
		for (const goals of Object.values(data.team)) collect(goals);
	}

	if (allGoals.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: allGoals.map((g) => g.id) };

	const transferred = [];
	for (const goal of allGoals) {
		goal.ownerId = toUserId;
		goal.owners = [{ ownerId: toUserId, ownerType: 'USER', primary: false }];
		const res = await attempt(`update goal ${goal.id}`, () => api.put(`/social/v1/objectives/${goal.id}`, goal));
		if (res.ok) transferred.push(goal.id);
	}
	return { transferred };
}

async function transferGroups(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const limit = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`list groups offset=${offset}`, () =>
				api.get(`/content/v2/groups/grouplist?owner=${fromUserId}&limit=${limit}&offset=${offset}`)
			);
			if (!res || res.length === 0) break;
			const ownedIds = res.filter((g) => g.owners.some((o) => o.id === fromUserId)).map((g) => g.id);
			ids.push(...ownedIds);
			if (res.length < limit) break;
			offset += limit;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	// The groups endpoint adds the new owner and removes the previous one in the
	// same call, so there's no separate removeOldOwner pass here.
	const removeOldOwner = fromUserId && !keepPreviousOwner;
	const transferred = await reassignOwnersInBatches(ids, {
		label: 'group',
		addOwner: (groupIds) =>
			api.put(
				'/content/v2/groups/access',
				groupIds.map((gid) => ({
					groupId: gid,
					addOwners: [{ type: 'USER', id: toUserId }],
					...(removeOldOwner && { removeOwners: [{ type: 'USER', id: fromUserId }] })
				}))
			)
	});
	return { transferred };
}

async function transferJupyterWorkspaces(fromUserId, toUserId, filteredIds, { dryRun }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const limit = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`search workspaces offset=${offset}`, () =>
				api.post('/datascience/v1/search/workspaces', {
					sortFieldMap: { LAST_RUN: 'DESC' },
					searchFieldMap: {},
					filters: [{ type: 'OWNER', values: [fromUserId] }],
					offset,
					limit
				})
			);
			if (!res || !res.workspaces || res.workspaces.length === 0) break;
			ids.push(...res.workspaces.map((w) => w.id));
			if (res.workspaces.length < limit) break;
			offset += limit;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const res = await attempt(`reassign workspace ${id}`, () =>
			api.put(`/datascience/v1/workspaces/${id}/ownership`, { newOwnerId: toUserId })
		);
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferMetrics(fromUserId, toUserId, filteredIds, { dryRun }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const limit = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`list metrics offset=${offset}`, () =>
				api.post('/content/v1/metrics/filter', {
					nameContains: 'string',
					filters: { OWNER: [fromUserId] },
					orderBy: 'CREATED',
					followed: false,
					descendingOrderBy: false,
					limit,
					offset
				})
			);
			if (!res || !res.metrics || res.metrics.length === 0) break;
			ids.push(...res.metrics.map((m) => m.id));
			if (res.metrics.length < limit) break;
			offset += limit;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const ok = await safe(`reassign metric ${id}`, () => api.post(`/content/v1/metrics/${id}/owner/${toUserId}`));
		if (ok !== null) transferred.push(id);
	}
	return { transferred };
}

async function transferPages(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const limit = 50;
		let skip = 0;
		while (true) {
			const res = await safe(`list pages skip=${skip}`, () =>
				api.post(`/content/v1/pages/adminsummary?limit=${limit}&skip=${skip}`, {
					addPageWithNoOwner: false,
					includePageOwnerClause: 1,
					ownerIds: [fromUserId],
					groupOwnerIds: [],
					orderBy: 'pageTitle',
					ascending: true
				})
			);
			const summaries = res && res.pageAdminSummaries;
			if (!summaries || summaries.length === 0) break;
			ids.push(...summaries.map((p) => p.pageId));
			if (summaries.length < limit) break;
			skip += limit;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = await reassignOwnersInBatches(ids, {
		label: 'page',
		addOwner: (pageIds) =>
			api.put('/content/v1/pages/bulk/owners', {
				owners: [{ id: toUserId, type: 'USER' }],
				pageIds
			}),
		removeOldOwner:
			fromUserId && !keepPreviousOwner
				? (pageIds) =>
						api.post('/content/v1/pages/bulk/owners/remove', {
							owners: [{ id: parseInt(fromUserId, 10), type: 'USER' }],
							pageIds
						})
				: null
	});
	return { transferred };
}

async function transferProjectsAndTasks(fromUserId, toUserId, filteredProjectIds, filteredTaskIds, { dryRun }) {
	const projects = [];
	const tasks = [];

	if (filteredProjectIds.length > 0 || filteredTaskIds.length > 0) {
		for (const id of filteredProjectIds) {
			const project = await safe(`get project ${id}`, () => api.get(`/content/v1/projects/${id}`));
			if (project && (!fromUserId || project.assignedTo == fromUserId)) projects.push(project);
		}
		for (const id of filteredTaskIds) {
			const task = await safe(`get task ${id}`, () => api.get(`/content/v1/tasks/${id}`));
			if (task) tasks.push(task);
		}
	} else {
		const limit = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`list user projects offset=${offset}`, () =>
				api.get(`/content/v2/users/${fromUserId}/projects?limit=${limit}&offset=${offset}`)
			);
			if (!res || !Array.isArray(res.projects) || res.projects.length === 0) break;
			projects.push(...res.projects);
			if (res.projects.length < limit) break;
			offset += limit;
		}
		for (const project of projects) {
			const taskRes = await safe(`list project ${project.id} tasks`, () =>
				api.get(`/content/v1/projects/${project.id}/tasks?assignedToOwnerId=${fromUserId}`)
			);
			if (Array.isArray(taskRes)) tasks.push(...taskRes);
		}
	}

	const projectMatchesSource = (p) => !fromUserId || p.assignedTo == fromUserId;

	if (dryRun) {
		return {
			transferred: [...projects.filter(projectMatchesSource).map((p) => p.id), ...tasks.map((t) => t.id)],
			projects: projects.filter(projectMatchesSource).map((p) => p.id),
			tasks: tasks.map((t) => t.id)
		};
	}

	const assignedBy = fromUserId || toUserId;
	const transferredTaskIds = [];
	for (const task of tasks) {
		transferredTaskIds.push(task.id);
		if (!fromUserId || task.primaryTaskOwner == fromUserId) task.primaryTaskOwner = toUserId;
		task.contributors = task.contributors || [];
		task.owners = task.owners || [];
		task.contributors.push({ assignedTo: toUserId, assignedBy });
		task.owners.push({ assignedTo: toUserId, assignedBy });
		await safe(`update task ${task.id}`, () => api.put(`/content/v1/tasks/${task.id}`, task));
	}

	const transferredProjectIds = [];
	for (const project of projects) {
		if (projectMatchesSource(project)) {
			transferredProjectIds.push(project.id);
			await safe(`update project ${project.id}`, () =>
				api.put(`/content/v1/projects/${project.id}`, {
					id: project.id,
					creator: toUserId
				})
			);
		}
	}
	return {
		transferred: [...transferredProjectIds, ...transferredTaskIds],
		projects: transferredProjectIds,
		tasks: transferredTaskIds
	};
}

async function transferRepositories(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const limit = 50;
		let offset = 0;
		while (true) {
			const res = await safe(`search repositories offset=${offset}`, () =>
				api.post('/version/v1/repositories/search', {
					query: {
						offset,
						limit,
						fieldSearchMap: {},
						sort: 'lastCommit',
						order: 'desc',
						filters: { userId: [fromUserId] },
						dateFilters: {}
					}
				})
			);
			if (!res || !res.repositories || res.repositories.length === 0) break;
			ids.push(...res.repositories.map((r) => r.id));
			if (res.repositories.length < limit) break;
			offset += limit;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const updates = [{ userId: toUserId, permission: 'OWNER' }];
	if (fromUserId && !keepPreviousOwner) {
		updates.push({ userId: fromUserId, permission: 'NONE' });
	}
	const transferred = [];
	for (const id of ids) {
		const res = await attempt(`reassign repository ${id}`, () =>
			api.post(`/version/v1/repositories/${id}/permissions`, {
				repositoryPermissionUpdates: updates
			})
		);
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferScheduledReports(fromUserId, toUserId, filteredIds, { dryRun }) {
	// When no filtered list is supplied we have no cheap way to list this user's
	// scheduled reports without a domostats dataset, so tell the caller.
	let ids = filteredIds;
	if (ids.length === 0) {
		console.warn('  (scheduled-report discovery requires a domostats dataset and is not implemented here; skipping)');
		return { transferred: [] };
	}
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const report = await safe(`get report ${id}`, () => api.get(`/content/v1/reportschedules/${id}`));
		if (!report) continue;
		const res = await attempt(`update report ${id}`, () =>
			api.put(`/content/v1/reportschedules/${id}`, {
				id: report.id,
				ownerId: toUserId,
				schedule: report.schedule,
				subject: report.subject,
				viewId: report.viewId
			})
		);
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferSubscriptions(fromUserId, toUserId, filteredIds, { dryRun }) {
	const toTransfer = [];
	if (filteredIds.length > 0) {
		for (const subId of filteredIds) {
			const sub = await safe(`get subscription ${subId}`, () => api.get(`/publish/v2/subscriptions/${subId}/share`));
			if (sub && (!fromUserId || sub.userId == fromUserId)) toTransfer.push(sub);
		}
	} else {
		const summaries = await safe('list subscription summaries', () => api.get('/publish/v2/subscriptions/summaries'));
		if (summaries) {
			for (const summary of summaries) {
				const sub = await safe(`get subscription ${summary.subscriptionId}`, () =>
					api.get(`/publish/v2/subscriptions/${summary.subscriptionId}/share`)
				);
				if (sub && sub.userId == fromUserId) toTransfer.push(sub);
			}
		}
	}
	if (toTransfer.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: toTransfer.map((s) => s.subscription.id) };

	const transferred = [];
	for (const sub of toTransfer) {
		const sid = sub.subscription.id;
		await safe(`update subscription ${sid}`, () =>
			api.put(`/publish/v2/subscriptions/${sid}`, {
				publicationId: sub.subscription.publicationId,
				domain: sub.subscription.domain,
				customerId: sub.subscription.customerId,
				userId: toUserId,
				userIds: sub.shareUsers,
				groupIds: sub.shareGroups
			})
		);
		transferred.push(sid);
	}
	return { transferred };
}

async function transferTaskCenterQueues(fromUserId, toUserId, filteredIds, { dryRun }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const count = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`search queues offset=${offset}`, () =>
				api.post('/search/v1/query', {
					query: '*',
					entityList: [['queue']],
					count,
					offset,
					filters: [
						{
							facetType: 'user',
							filterType: 'term',
							field: 'owned_by_id',
							value: `${fromUserId}:USER`
						}
					]
				})
			);
			if (!res || !res.searchObjects || res.searchObjects.length === 0) break;
			ids.push(...res.searchObjects.map((q) => q.uuid));
			if (res.searchObjects.length < count) break;
			offset += count;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const res = await attempt(`set queue ${id} owner`, () => api.put(`/queues/v1/${id}/owner/${toUserId}`));
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferTaskCenterTasks(fromUserId, toUserId, filteredIds, { dryRun }) {
	let tasks;
	if (filteredIds.length > 0) {
		// For CSV-supplied task IDs we don't know the queueId, so we can't reassign them.
		tasks = filteredIds.map((id) => ({ id, queueId: null }));
	} else {
		tasks = [];
		const limit = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`list tasks offset=${offset}`, () =>
				api.post(`/queues/v1/tasks/list?limit=${limit}&offset=${offset}`, {
					assignedTo: [fromUserId],
					status: ['OPEN']
				})
			);
			if (!res || res.length === 0) break;
			tasks.push(...res.map((t) => ({ id: t.id, queueId: t.queueId })));
			if (res.length < limit) break;
			offset += limit;
		}
	}
	if (tasks.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: tasks.map((t) => t.id) };

	const transferred = [];
	for (const t of tasks) {
		if (!t.queueId) {
			console.warn(`  - task ${t.id}: queueId unknown, cannot reassign`);
			continue;
		}
		await safe(`reassign task ${t.id}`, () =>
			api.put(`/queues/v1/${t.queueId}/tasks/${t.id}/assign`, {
				userId: toUserId,
				type: 'USER',
				taskIds: [t.id]
			})
		);
		transferred.push(t.id);
	}
	return { transferred };
}

async function transferWorkflows(fromUserId, toUserId, filteredIds, { dryRun }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const count = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`search workflows offset=${offset}`, () =>
				api.post('/search/v1/query', {
					query: '*',
					entityList: [['workflow_model']],
					count,
					offset,
					filters: [
						{
							facetType: 'user',
							filterType: 'term',
							field: 'owned_by_id',
							value: `${fromUserId}:USER`
						}
					]
				})
			);
			if (!res || !res.searchObjects || res.searchObjects.length === 0) break;
			ids.push(...res.searchObjects.map((w) => w.uuid));
			if (res.searchObjects.length < count) break;
			offset += count;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const workflow = await safe(`get workflow ${id}`, () => api.get(`/workflow/v1/models/${id}`));
		if (!workflow) continue;
		workflow.owner = String(toUserId);
		const res = await attempt(`update workflow ${id}`, () => api.put(`/workflow/v1/models/${id}`, workflow));
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

// Worksheets live on the same DATA_APP backend as App Studio apps and share
// the /dataapps/bulk/owners endpoints; the adminsummary `type` filter is what
// separates them.
async function transferWorksheets(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner }) {
	let ids = filteredIds.map(String);
	if (ids.length === 0) {
		const limit = 30;
		let skip = 0;
		while (true) {
			const res = await safe(`list worksheets skip=${skip}`, () =>
				api.post(`/content/v1/dataapps/adminsummary?limit=${limit}&skip=${skip}`, {
					ascending: true,
					includeOwnerClause: true,
					includeTitleClause: true,
					orderBy: 'title',
					ownerIds: [fromUserId],
					titleSearchText: '',
					type: 'worksheet'
				})
			);
			const summaries = res && res.dataAppAdminSummaries;
			if (!summaries || summaries.length === 0) break;
			ids.push(...summaries.map((s) => String(s.dataAppId)));
			if (summaries.length < limit) break;
			skip += limit;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = await reassignOwnersInBatches(ids, {
		label: 'worksheet',
		addOwner: (entityIds) =>
			api.put('/content/v1/dataapps/bulk/owners', {
				note: '',
				entityIds,
				owners: [{ type: 'USER', id: parseInt(toUserId, 10) }],
				sendEmail: false
			}),
		removeOldOwner:
			fromUserId && !keepPreviousOwner
				? (entityIds) =>
						api.post('/content/v1/dataapps/bulk/owners/remove', {
							entityIds,
							owners: [{ type: 'USER', id: fromUserId }]
						})
				: null
	});
	return { transferred };
}

/**
 * Transfer workspace ownership. Per-workspace three-step flow (mirrors
 * domo-toolkit/src/services/workspaces.js):
 *   1. GET /nav/v1/workspaces/{id}/members — list current members.
 *   2. If destination user is already a member, PUT to promote their role to
 *      OWNER. Otherwise POST to add them as an OWNER member. (A bare POST for
 *      an existing member returns 200 without promoting, so the branch must be
 *      deterministic.)
 *   3. If the source user is a direct member, DELETE that membership. If the
 *      delete fails after step 2 succeeded, the workspace has two owners — we
 *      warn and continue so the caller can clean up manually.
 */
async function transferWorkspaces(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner }) {
	let ids = filteredIds;
	if (ids.length === 0) {
		const count = 100;
		let offset = 0;
		while (true) {
			const res = await safe(`search workspaces offset=${offset}`, () =>
				api.post('/search/v1/query', {
					combineResults: false,
					count,
					entityList: [['workspace']],
					facetValuesToInclude: [],
					filters: [
						{
							field: 'owned_by_id',
							filterType: 'term',
							name: 'Owned by',
							not: false,
							value: fromUserId
						}
					],
					hideSearchObjects: true,
					offset,
					query: '**',
					queryProfile: 'GLOBAL'
				})
			);
			const workspaces = res && res.searchResultsMap && res.searchResultsMap.workspace;
			if (!workspaces || workspaces.length === 0) break;
			ids.push(...workspaces.map((w) => String(w.databaseId ?? w.id)));
			if (workspaces.length < count) break;
			offset += count;
		}
	}
	if (ids.length === 0) return { transferred: [] };
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		try {
			const raw = await api.get(`/nav/v1/workspaces/${id}/members`);
			const members = Array.isArray(raw) ? raw : (raw && raw.members) || [];

			const destMember = members.find((m) => m.memberType === 'USER' && m.memberId === toUserId);
			const sourceMember = fromUserId
				? members.find((m) => m.memberType === 'USER' && m.memberId === fromUserId)
				: null;

			if (destMember) {
				await api.put(`/nav/v1/workspaces/${id}/members/${destMember.id}`, {
					...destMember,
					memberRole: 'OWNER'
				});
			} else {
				await api.post(`/nav/v1/workspaces/${id}/members/${toUserId}`, {
					members: [{ memberId: toUserId, memberRole: 'OWNER', memberType: 'USER' }],
					sendEmail: false
				});
			}

			if (sourceMember && !keepPreviousOwner) {
				try {
					await api.del(`/nav/v1/workspaces/${id}/members/${sourceMember.id}`);
				} catch (delErr) {
					const message = `promoted new OWNER but failed to remove previous owner — workspace may now have two owners (${delErr.message})`;
					console.warn(`  ⚠ workspace ${id}: ${message}`);
					failures.push({
						type: activeType,
						label: `remove previous owner from workspace ${id}`,
						message,
						time: new Date().toISOString()
					});
				}
			}
			transferred.push(id);
		} catch (err) {
			const message = err.message || String(err);
			console.error(`  ✗ workspace ${id}: ${message}`);
			failures.push({ type: activeType, label: `transfer workspace ${id}`, message, time: new Date().toISOString() });
		}
	}
	return { transferred };
}

_main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
