/**
 * Bulk transfer ownership of Domo content from one user to another.
 *
 * Two modes for choosing what to transfer:
 *   1) From user  — discover every object owned by --from-user and transfer it
 *   2) From file  — read specific object IDs (optionally mixed types) from a CSV
 *
 * --from-user may be omitted when explicit IDs are supplied (via --file or
 * --id/--ids). In that mode, the listed IDs are assigned to the new owner without
 * removing any existing owner — useful when the objects have no owner currently
 * assigned.
 *
 * Usage:
 *   # Transfer every type the user owns
 *   node cli.js bulk-transfer-ownership --from-user 12345 --to-owner 67890
 *
 *   # Transfer only specific types owned by the user
 *   node cli.js bulk-transfer-ownership --from-user 12345 --to-owner 67890 --object-types "dataset,dataflow,card"
 *
 *   # Transfer a CSV of mixed content — CSV has a type column
 *   node cli.js bulk-transfer-ownership --from-user 12345 --to-owner 67890 --file content.csv --type-column "Object Type ID"
 *
 *   # Transfer a CSV that is all one type — no type column needed
 *   node cli.js bulk-transfer-ownership --from-user 12345 --to-owner 67890 --file datasets.csv --object-types "dataset"
 *
 *   # Transfer an ad-hoc list of IDs of one type (no CSV)
 *   node cli.js bulk-transfer-ownership --from-user 12345 --to-owner 67890 --object-types "dataset" --ids "111,222,333"
 *   node cli.js bulk-transfer-ownership --from-user 12345 --to-owner 67890 --object-types "card" --id 789
 *
 *   # Assign ownership without specifying a previous owner (no --from-user)
 *   node cli.js bulk-transfer-ownership --to-owner 67890 --file datasets.csv --object-types "dataset"
 *   node cli.js bulk-transfer-ownership --to-owner 67890 --object-types "dataset" --ids "111,222,333"
 *
 *   # Route each row to a different new owner read from a CSV column
 *   node cli.js bulk-transfer-ownership --from-user 12345 --file content.csv --type-column "Object Type ID" --to-owner-column "New Owner ID"
 *
 *   # Transfer everything the user owns to a GROUP (user-only types are skipped + logged)
 *   node cli.js bulk-transfer-ownership --from-user 12345 --to-owner 67890 --to-owner-type group
 *
 *   # Route each row to a user OR group: one column holds the owner ID, another the kind
 *   node cli.js bulk-transfer-ownership --from-user 12345 --file content.csv --type-column "Object Type ID" --to-owner-column "New Owner ID" --to-owner-type-column "New Owner Type"
 *
 * Group ownership is only supported for: card, page, app-studio, worksheet, dataset,
 * workspace. For any other type, a GROUP destination is skipped and logged.
 *
 * Every run logs one row per object. A dry run's log is a plan: --from-dry-run
 * transfers exactly those objects without rediscovering, and --retry-errors re-runs
 * the failed and unreached objects of a real run. Both refuse logs older than 24h
 * (unless --max-age), and skip objects the --from-user no longer owns where the
 * current owner can be read.
 *
 *   node cli.js bulk-transfer-ownership --from-user 12345 --to-owner 67890 --dry-run
 *   node cli.js bulk-transfer-ownership --from-dry-run
 *   node cli.js bulk-transfer-ownership --retry-errors
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

const XLSX = require('xlsx');
const api = require('../lib/api');
const config = require('../lib/config');
const { readCSV } = require('../lib/csv');
const { showHelp } = require('../lib/help');
const { createLogger } = require('../lib/log');
const { confirmSource, loadSource, printSource, stripStatus } = require('../lib/plan');
const argv = require('minimist')(process.argv.slice(2));

const COMMAND = 'bulk-transfer-ownership';
const SELECTION_FLAGS = [
	'from-user',
	'to-owner',
	'to-owner-type',
	'to-owner-column',
	'to-owner-type-column',
	'file',
	'id',
	'ids',
	'id-column',
	'type-column',
	'name-column',
	'object-types',
	'keep-previous-owner',
	'prune-invalid-functions',
	'input-access-level',
	'send-email',
	'dry-run'
];

const HELP_TEXT = `Usage: node cli.js bulk-transfer-ownership [options]

Transfer ownership of Domo content from one user to a new user or group.

Required (one destination):
  --to-owner <id>      New owner's ID, of the kind given by --to-owner-type.
  --from-user <id>     Current owner's user ID (source). Required unless explicit IDs
                       are supplied via --file or --id/--ids.
  (--to-owner is not required when --to-owner-column supplies the destination per row.)

Optional:
  --to-owner-type <kind>  USER or GROUP (case-insensitive). Applies to --to-owner and
                       to every row when --to-owner-type-column is not given. Default: USER.
  --file <path>        CSV file with specific IDs to transfer (instead of discovering everything)
  --id, --ids <ids>    Single ID / comma-separated IDs to transfer (instead of --file or
                       discovery). Requires exactly one --object-types. Cannot be combined
                       with --file or the per-row --to-owner-column / --to-owner-type-column.
  --id-column <name>   CSV column with object IDs (default: "Object ID")
  --to-owner-column <name> CSV column holding the destination owner ID per row. Only valid
                       with --file. Rows are grouped by owner (type + id) and each new owner
                       is processed in turn, so different objects can go to different owners
                       in one run.
  --to-owner-type-column <name> CSV column holding USER/GROUP per row (case-insensitive).
                       Only valid with --file. When omitted, --to-owner-type applies to all rows.
  --type-column <name> CSV column with object type per row — needed when the CSV mixes types
  --name-column <name> CSV column with each object's display name. Only valid with --file.
                       When given, the --send-email attachment includes an "Object Name" column.
  --object-types <csv> Comma-separated list of types to include. Omit to transfer every type.
                       When --file is used without --type-column, this must be exactly one type
                       and is applied to every row.
  --keep-previous-owner Do NOT remove the previous owner for types that support multiple
                       owners (card, app-studio, page, worksheet, group, repository, workspace).
                       Implied when --from-user is omitted (there's no previous owner to
                       remove), so it's only meaningful alongside --from-user.
  --verify             After transferring, re-read every transferred object and confirm
                       the new owner is present (and the previous owner gone, unless
                       --keep-previous-owner). Reports anything that did not move, was
                       left ownerless, or vanished. Verifiable types: card, page,
                       app-studio, beast-mode, variable, dataset, dataflow, custom-app;
                       others are reported as unverified rather than assumed fine.
                       Skipped on a dry run.
  --prune-invalid-functions
                       Beast modes/variables only. Inspect each formula's links and
                       DELETE the formula when every link is dead, or when a visible link
                       is dead; unlink dead links otherwise. This is cleanup, not transfer,
                       so it is OFF by default: without it a transfer only changes the
                       owner and echoes the links back untouched. Deletions are printed,
                       and a dry run with this flag lists what it would destroy.
  --input-access-level <level> Access level granted to the new owner on a transferred
                       dataflow's input datasets when they don't already have access
                       (directly or via group). One of CAN_VIEW, CAN_EDIT, CAN_SHARE, OWNER.
                       Default: CAN_VIEW.
  --send-email         After transferring, email the new owner a per-type summary with
                       the full per-object list attached as an .xlsx (includes an
                       "Object Name" column when --name-column is given). Skipped on a dry run.
  --dry-run            Print what would be transferred without calling any write endpoints
  --help               Show this help

Reusing an earlier run (skips discovery; the log's options are reused, --verify may be added):
  --from-dry-run [file]  Run exactly what a dry run planned (default: the latest dry run log)
  --retry-errors [file]  Retry the failed and unreached items of a run (default: the latest run log)
  --max-age <hours>      Allow a source log older than 24 hours
  --yes, -y              Skip the confirmation prompt

Object types (case-insensitive, hyphens or underscores both accepted):
  account, ai-model, ai-project, alert, app-studio, approval, beast-mode, card,
  code-engine, collection, custom-app, dataflow, dataset, fileset, goal, group,
  jupyter, metric, page, project, project-task, publication, queue, repository,
  scheduled-report, subscription, task, template, variable, workflow,
  worksheet, workspace

Notes:
  - GROUP ownership is only supported by these types: card, page, app-studio, worksheet,
    dataset, workspace. When a destination is a GROUP, every other type is skipped and
    recorded in the run log (best-effort).
  - When a dataflow is transferred, the new owner is checked for access to each of the
    dataflow's input datasets (direct USER grant or inherited via group membership). Any
    input they can't reach is shared with them directly (see --input-access-level).
  - "publication" is never actually transferred (platform limitation); it is only reported.
  - "custom-app" moves ownership with PUT /apps/v1/designs/{id}/transfer-owner. Where that
    endpoint is not deployed it falls back to an ADMIN permission grant, which does NOT
    move "owner". Those designs are counted separately and called out as
    "got only an ADMIN grant"; they are not reported as transferred.
  - "approval" and "template" only discover from the --from-user; they ignore filtered IDs.
  - "goal" only discovers from the --from-user; it ignores filtered IDs.
  - When --from-user is omitted, "approval", "template", and "goal" cannot be processed.
  - --from-dry-run / --retry-errors first re-read the current owner of each card, page,
    app-studio, beast-mode, variable, dataset, dataflow, custom-app, workflow,
    scheduled-report, subscription and project, and skip it (reason "owner-changed") when
    the --from-user no longer owns it. "approval", "template" and "goal" are re-discovered
    from the --from-user and only the planned ones are acted on. Other types are replayed
    without an owner check.`;

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

// Types whose reassignment endpoints accept a GROUP owner (their payloads take a
// { type, id } owner). Every other type is user-only; a GROUP destination for
// those is skipped and logged (see transferForUser). Keep this conservative —
// adding a type here means its handler passes ctx.toOwnerType into the API call.
const GROUP_CAPABLE_TYPES = new Set(['app-studio', 'card', 'dataset', 'page', 'worksheet', 'workspace']);

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

	const source = loadSource(COMMAND, argv, { selectionFlags: SELECTION_FLAGS, toEntries: toPlanEntry });
	const opts = source ? optionsFromMeta(source.meta) : optionsFromArgv();
	const { fromUserId, dryRun, sendEmail, keepPreviousOwner, pruneInvalidFunctions, verify, inputAccessLevel } = opts;

	let groups;
	let objectNames;
	let upfrontEntries;
	if (source) {
		groups = groupsFromEntries(source.entries);
		objectNames = opts.nameColumn
			? new Map(source.entries.filter((e) => e.name != null).map((e) => [`${e.type}:${e.id}`, e.name]))
			: null;
		upfrontEntries = source.entries;
	} else {
		({ groups, objectNames } = buildGroups(opts));
		upfrontEntries = entriesFromGroups(groups, objectNames);
	}

	const fromUserName = source ? source.meta.fromUserName || null : fromUserId ? await getUserName(fromUserId) : null;

	const perRowOwner = Boolean(opts.ownerColumn) || Boolean(opts.ownerTypeColumn);
	const toOwnerLabel = perRowOwner
		? `multiple (per CSV${opts.ownerColumn ? ` "${opts.ownerColumn}"` : ''})`
		: `${opts.runOwnerType} ${opts.singleOwnerId}`;
	const logger = createLogger(COMMAND, {
		debugMode: false,
		dryRun,
		source,
		runMeta: {
			fromUserId: fromUserId || null,
			fromUserName,
			toOwner: toOwnerLabel,
			toOwnerId: opts.singleOwnerId != null ? String(opts.singleOwnerId) : null,
			toOwnerType: opts.runOwnerType,
			mode: opts.mode,
			file: opts.file || null,
			idColumn: opts.idColumn || null,
			typeColumn: opts.typeColumn || null,
			ownerColumn: opts.ownerColumn || null,
			ownerTypeColumn: opts.ownerTypeColumn || null,
			nameColumn: opts.nameColumn || null,
			keepPreviousOwner,
			pruneInvalidFunctions,
			inputAccessLevel,
			sendEmail,
			verify,
			requestedTypes: opts.requestedTypes || 'all'
		}
	});

	const modeLabel =
		{ file: `file (${opts.file})`, ids: 'ids (command line)', user: 'user discovery' }[opts.mode] || String(opts.mode);
	console.log('Bulk Transfer Ownership');
	console.log('========================');
	console.log(`From:      ${fromUserId ? `${fromUserName} (${fromUserId})` : '(none, assigning new owner)'}`);
	if (perRowOwner) {
		console.log(`To:        per CSV (${groups.length} destination owner(s))`);
	} else {
		console.log(`To:        ${toOwnerLabel}`);
	}
	console.log(`Mode:      ${source ? `--${source.mode} (planned by ${modeLabel})` : modeLabel}`);
	if (keepPreviousOwner) console.log('Keep previous owner: previous owner will NOT be removed for multi-owner types.');
	if (pruneInvalidFunctions) {
		console.log(
			'Prune invalid functions: beast modes/variables whose links are all dead WILL BE DELETED, not transferred.'
		);
	}
	if (verify) console.log('Verify: each transferred object will be re-read afterwards to confirm the owner actually moved.');
	if (sendEmail) console.log('Send email: each new owner will be emailed a summary of transferred assets.');
	if (dryRun) console.log('DRY RUN: no write calls will be made.');

	const summary = { totals: {}, items: {}, skipped: [], details: [], errors: failures };

	if (source) {
		console.log();
		printSource(source);
		printPlanOverview(groups);
		if (!fromUserId) {
			console.log('No source user was recorded, so current owners are not checked before transferring.\n');
		}
		if (source.entries.length === 0) {
			console.log('The source log has nothing left to transfer.');
			logger.writeRunLog(summary);
			return;
		}
		if (!(await confirmSource(`Transfer these ${source.entries.length} item(s)? (yes/no): `, argv))) {
			console.log('Aborted.');
			process.exit(0);
		}
	}

	const plannedKeys = new Set();
	const beginPlanned = (entries) => {
		const fresh = [];
		for (const entry of entries) {
			const key = planKey(entry);
			if (plannedKeys.has(key)) continue;
			plannedKeys.add(key);
			fresh.push(entry);
		}
		if (fresh.length > 0) logger.beginExecution(fresh, planKey);
	};
	beginPlanned(upfrontEntries);

	const ownerNameCache = {};

	for (const group of groups) {
		const groupOwnerId = group.toUserId;
		const groupOwnerType = group.toOwnerType;
		if (fromUserId && groupOwnerType === 'USER' && String(fromUserId) === String(groupOwnerId)) {
			console.warn(`\nSkipping destination user ${groupOwnerId}: same as --from-user.`);
			for (const [type, ids] of Object.entries(group.objectsByType || {})) {
				for (const id of ids) {
					logger.addResult({
						type,
						id: String(id),
						toOwnerId: String(groupOwnerId),
						toOwnerType: groupOwnerType,
						status: 'skipped',
						reason: 'same-as-source'
					});
				}
			}
			continue;
		}
		const cacheKey = `${groupOwnerType}:${groupOwnerId}`;
		if (!(cacheKey in ownerNameCache)) {
			ownerNameCache[cacheKey] = await getOwnerName(groupOwnerId, groupOwnerType);
		}
		const groupOwnerName = ownerNameCache[cacheKey];

		if (groups.length > 1) {
			console.log(`\n##### Transferring to ${groupOwnerType} ${groupOwnerName} (${groupOwnerId}) #####`);
		}

		const ctx = {
			fromUserId,
			toUserId: groupOwnerId,
			toOwnerType: groupOwnerType,
			fromUserName,
			toUserName: groupOwnerName,
			dryRun,
			keepPreviousOwner,
			pruneInvalidFunctions,
			inputAccessLevel,
			beginPlanned,
			source: Boolean(source),
			checkOwner: Boolean(source && fromUserId),
			planFields: group.fields || null,
			objectNames
		};

		const transferredByType = await transferForUser({
			ctx,
			objectsByType: group.objectsByType,
			requestedTypes: opts.requestedTypes,
			logger,
			summary
		});

		if (verify && !dryRun) {
			const result = await verifyTransfers({
				transferredByType,
				toUserId: groupOwnerId,
				toOwnerType: groupOwnerType,
				fromUserId,
				keepPreviousOwner
			});
			const owner = { toOwnerId: String(groupOwnerId), toOwnerType: groupOwnerType };
			summary.verified = (summary.verified || 0) + result.confirmed;
			summary.verifyProblems = (summary.verifyProblems || []).concat(result.problems.map((p) => ({ ...p, ...owner })));
			summary.unverified = (summary.unverified || []).concat(result.unverified.map((u) => ({ ...u, ...owner })));
		}

		if (sendEmail) {
			console.log('\n=== email ===');
			activeType = 'email';
			if (dryRun) {
				console.log('  Dry run: skipping email to the new owner.');
			} else {
				await sendTransferEmail({
					toUserId: groupOwnerId,
					toOwnerType: groupOwnerType,
					toUserName: groupOwnerName,
					fromUserId,
					fromUserName,
					transferredByType,
					objectNames
				});
			}
		}
	}

	console.log('\n=== Summary ===');
	for (const [type, count] of Object.entries(summary.totals)) {
		console.log(`  ${type}: ${count}`);
	}
	const itemCounts = Object.entries(summary.items).map(([status, n]) => `${n} ${status}`);
	console.log(`Items:     ${itemCounts.length > 0 ? itemCounts.join(', ') : 'none'}`);
	if (summary.skipped.length > 0) {
		console.log('Skipped:');
		for (const s of summary.skipped) {
			console.log(`  ${s.type} (${s.reason}): ${s.ids.length}`);
		}
	}
	if (verify && !dryRun) {
		console.log(`Verified:  ${summary.verified || 0} object(s) confirmed with the new owner`);
		if ((summary.verifyProblems || []).length > 0) {
			console.log(`Unverified: ${summary.verifyProblems.length} object(s) did NOT verify (see run log)`);
		}
	}
	if (failures.length > 0) {
		console.log(`Errors:    ${failures.length} (see run log for details)`);
	}
	logger.writeRunLog(summary);
	if (dryRun) {
		console.log(`Run "node cli.js ${COMMAND} --from-dry-run" to apply this plan.`);
	} else if (summary.items.error) {
		console.log(`${summary.items.error} item(s) failed. Run "node cli.js ${COMMAND} --retry-errors" to retry them.`);
	}
	if (summary.items['discovery-error']) {
		console.log(
			`${summary.items['discovery-error']} lookup(s) failed before anything was changed (see run log); items they would have found are not in this log, so re-run the discovery for them.`
		);
	}
}

// -----------------------------------------------------------------------------
// Every other function below: alphabetical by name. Enforced by
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

function buildGroups({
	file: filePath,
	typeColumn,
	idColumn,
	singleOwnerId,
	ownerColumn,
	ownerTypeColumn: toOwnerTypeColumn,
	idsRaw,
	nameColumn,
	runOwnerType,
	requestedTypes
}) {
	// Each group is one destination owner (id + type) plus the objectsByType map of
	// what they should receive; objectsByType is null when discovering from --from-user.
	const objectNames = nameColumn ? new Map() : null;
	let groups;
	if (filePath) {
		const records = readCSV(filePath);
		if (records.length === 0) throw new Error('CSV file has no rows');
		const columns = Object.keys(records[0]);
		if (!columns.includes(idColumn)) {
			throw new Error(`ID column "${idColumn}" not found in CSV. Available: ${columns.join(', ')}`);
		}
		if (ownerColumn && !columns.includes(ownerColumn)) {
			throw new Error(`Owner column "${ownerColumn}" not found in CSV. Available: ${columns.join(', ')}`);
		}
		if (toOwnerTypeColumn && !columns.includes(toOwnerTypeColumn)) {
			throw new Error(`Owner-type column "${toOwnerTypeColumn}" not found in CSV. Available: ${columns.join(', ')}`);
		}
		if (nameColumn && !columns.includes(nameColumn)) {
			throw new Error(`Name column "${nameColumn}" not found in CSV. Available: ${columns.join(', ')}`);
		}
		if (!typeColumn) {
			if (!requestedTypes || requestedTypes.length !== 1) {
				throw new Error('With --file and no --type-column, --object-types must specify exactly one type.');
			}
		} else if (!columns.includes(typeColumn)) {
			throw new Error(`Type column "${typeColumn}" not found in CSV. Available: ${columns.join(', ')}`);
		}

		const byOwner = new Map();
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
			const rowOwnerId = ownerColumn ? String(row[ownerColumn] || '').trim() : String(singleOwnerId);
			if (!rowOwnerId) {
				console.warn(`  Skipping row with id=${id}: blank "${ownerColumn}" value.`);
				continue;
			}
			let rowOwnerType;
			if (toOwnerTypeColumn) {
				rowOwnerType = normalizeOwnerType(row[toOwnerTypeColumn]);
				if (!rowOwnerType) {
					console.warn(
						`  Skipping row with id=${id}: invalid "${toOwnerTypeColumn}" value "${row[toOwnerTypeColumn]}" (expected USER or GROUP).`
					);
					continue;
				}
			} else {
				rowOwnerType = runOwnerType;
			}
			const key = `${rowOwnerType}:${rowOwnerId}`;
			if (!byOwner.has(key)) byOwner.set(key, { toUserId: rowOwnerId, toOwnerType: rowOwnerType, objectsByType: {} });
			const { objectsByType } = byOwner.get(key);
			if (!objectsByType[canon]) objectsByType[canon] = [];
			objectsByType[canon].push(id);
			if (objectNames) objectNames.set(`${canon}:${id}`, cleanObjectName(row[nameColumn]));
		}
		groups = [...byOwner.values()];
		if (groups.length === 0) throw new Error('CSV produced no transferable rows.');
	} else if (idsRaw != null) {
		// Ad-hoc IDs of a single type, all going to the single destination owner.
		if (!requestedTypes || requestedTypes.length !== 1) {
			throw new Error('--id/--ids require exactly one --object-types.');
		}
		const ids = idsRaw
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (ids.length === 0) throw new Error('--id/--ids produced no IDs.');
		groups = [{ toUserId: String(singleOwnerId), toOwnerType: runOwnerType, objectsByType: { [requestedTypes[0]]: ids } }];
	} else {
		groups = [{ toUserId: String(singleOwnerId), toOwnerType: runOwnerType, objectsByType: null }];
	}
	return { groups, objectNames };
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

// Reduce a --name-column value to plain text for the email attachment. CSV
// exports often store the name as an HTML anchor (e.g.
// <a name="April 2026 Opportunities" href="...">April 2026 Opportunities</a>);
// take the link's visible text (falling back to its name/title attribute), strip
// any remaining tags, then decode the handful of HTML entities Domo emits.
function cleanObjectName(raw) {
	if (raw == null) return '';
	let value = String(raw).trim();
	if (!value) return '';
	const anchor = value.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
	if (anchor) {
		const inner = anchor[1].replace(/<[^>]*>/g, '').trim();
		if (inner) {
			value = inner;
		} else {
			const attr = value.match(/\b(?:name|title)\s*=\s*"([^"]*)"/i);
			value = attr ? attr[1].trim() : '';
		}
	} else if (value.includes('<')) {
		value = value.replace(/<[^>]*>/g, '').trim();
	}
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.trim();
}

function createRecorder({ ctx, logger, summary, transferredByType }) {
	const owner = { toOwnerId: String(ctx.toUserId), toOwnerType: ctx.toOwnerType };
	const rec = {
		count(type) {
			summary.totals[type] = summary.totals[type] || 0;
		},
		entry(type, item) {
			const { id, type: _itemType, ...fields } = item !== null && typeof item === 'object' ? item : { id: item };
			const key = `${type}:${id}`;
			const known = (ctx.planFields && ctx.planFields.get(key)) || {};
			const name = ctx.objectNames && ctx.objectNames.get(key);
			return { ...known, type, id: String(id), ...owner, ...(name ? { name } : {}), ...fields };
		},
		log(entry, status, extra = {}) {
			logger.addResult({ ...entry, status, ...extra });
			const counter = extra.phase === 'discover' ? 'discovery-error' : status;
			summary.items[counter] = (summary.items[counter] || 0) + 1;
			if ((status === 'transferred' || status === 'dry-run') && extra.action !== 'delete') {
				summary.totals[entry.type] = (summary.totals[entry.type] || 0) + 1;
				if (!transferredByType[entry.type]) transferredByType[entry.type] = [];
				transferredByType[entry.type].push(entry.id);
			}
		},
		skipIds(type, ids, reason) {
			for (const id of ids) rec.log(rec.entry(type, id), 'skipped', { reason });
		},
		typeRow(type) {
			return { type, ...owner };
		}
	};
	return rec;
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

function entriesFromGroups(groups, objectNames) {
	const entries = [];
	for (const group of groups) {
		for (const [type, ids] of Object.entries(group.objectsByType || {})) {
			for (const id of ids) {
				const name = objectNames && objectNames.get(`${type}:${id}`);
				entries.push({
					type,
					id: String(id),
					toOwnerId: String(group.toUserId),
					toOwnerType: group.toOwnerType,
					...(name ? { name } : {})
				});
			}
		}
	}
	return entries;
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

function failureIds(failure) {
	const ids = new Set(String(failure.label).split(/\s+/));
	const context = failure.context;
	if (context && typeof context === 'object') {
		for (const value of Object.values(context)) {
			for (const v of Array.isArray(value) ? value : [value]) {
				if (v != null && typeof v !== 'object') ids.add(String(v));
			}
		}
	}
	return ids;
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

async function getGroupName(groupId) {
	const res = await safe(`get group ${groupId}`, () => api.get(`/content/v2/groups/${groupId}`));
	return (res && res.name) || `Group ${groupId}`;
}

// Display name for a destination owner of either kind.
async function getOwnerName(id, type) {
	return type === 'GROUP' ? getGroupName(id) : getUserName(id);
}


// New owner's email address, used as the `recipients` query param on the
// messages endpoint (see sendTransferEmail). Returns null if it can't be
// resolved; the message is still routed by recipientsUserIds in that case.
async function getUserEmail(userId) {
	const res = await safe(`get user email ${userId}`, () => api.get(`/content/v3/users/${userId}`));
	return (res && (res.emailAddress || res.email)) || null;
}

// New owner's group IDs (as strings), one call, used to detect inherited
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

function groupsFromEntries(entries) {
	const byOwner = new Map();
	for (const entry of entries) {
		const key = `${entry.toOwnerType}:${entry.toOwnerId}`;
		if (!byOwner.has(key)) {
			byOwner.set(key, {
				toUserId: String(entry.toOwnerId),
				toOwnerType: entry.toOwnerType,
				objectsByType: {},
				fields: new Map()
			});
		}
		const group = byOwner.get(key);
		if (!group.objectsByType[entry.type]) group.objectsByType[entry.type] = [];
		group.objectsByType[entry.type].push(String(entry.id));
		group.fields.set(`${entry.type}:${entry.id}`, entry);
	}
	return [...byOwner.values()];
}

function indexFailures(errors) {
	const byId = new Map();
	for (const failure of errors) {
		for (const id of failureIds(failure)) {
			if (!byId.has(id)) byId.set(id, []);
			byId.get(id).push(failure);
		}
	}
	return byId;
}

// The last match is the most specific: a failed batch is followed by its per-id retries.
function lastFailure(failuresById, id, predicate = () => true) {
	const list = failuresById.get(id) || [];
	for (let i = list.length - 1; i >= 0; i--) {
		if (predicate(list[i])) return list[i];
	}
	return null;
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

// Map a free-form owner-type token (user/group, any case) to USER/GROUP. Returns
// `fallback` when the token is blank/absent, or null when it's present but not a
// recognized type (so callers can reject it).
function normalizeOwnerType(raw, fallback = null) {
	if (raw == null || String(raw).trim() === '') return fallback;
	const key = String(raw).trim().toLowerCase();
	if (key === 'user') return 'USER';
	if (key === 'group') return 'GROUP';
	return null;
}

function normalizeType(raw) {
	if (!raw) return null;
	const key = String(raw).trim().toLowerCase().replace(/_/g, '-');
	return ALIAS_TO_CANONICAL[key] || null;
}

function optionsFromArgv() {
	const fromUserId = argv['from-user'];
	const filePath = argv.file;
	const typeColumn = argv['type-column'];
	const idColumn = argv['id-column'] || 'Object ID';
	const dryRun = Boolean(argv['dry-run']);
	const sendEmailFlag = Boolean(argv['send-email']);
	const keepPreviousOwner = Boolean(argv['keep-previous-owner']);
	const pruneInvalidFunctions = Boolean(argv['prune-invalid-functions']);
	const verify = Boolean(argv.verify);
	const inputAccessLevel = String(argv['input-access-level'] || 'CAN_VIEW').toUpperCase();

	// Destination owner. The owner ID comes from --to-owner (single) or the
	// --to-owner-column CSV column; the owner type from --to-owner-type (applied to
	// every row) or the per-row --to-owner-type-column. Type tokens are parsed
	// case-insensitively (user/group) and default to USER.
	const singleOwnerId = argv['to-owner'];
	const ownerColumn = argv['to-owner-column'] || null;
	const toOwnerTypeColumn = argv['to-owner-type-column'];
	// Ad-hoc IDs supplied on the command line instead of a CSV. --id and --ids are
	// equivalent (both comma-separated). Like bulk-delete-content, this requires
	// exactly one --object-types since there's no per-row type column.
	const idsRaw = argv.id != null ? String(argv.id) : argv.ids != null ? String(argv.ids) : null;
	// Optional CSV column holding each object's display name, used only to fill the
	// "Object Name" column in the --send-email attachment.
	const nameColumn = argv['name-column'] || null;

	if (!DATASET_ACCESS_LEVELS.includes(inputAccessLevel)) {
		throw new Error(`Invalid --input-access-level. Must be one of: ${DATASET_ACCESS_LEVELS.join(', ')}`);
	}

	// Owner type applied to the single destination, and to every row when
	// --to-owner-type-column is not supplied. Defaults to USER.
	const runOwnerType = normalizeOwnerType(argv['to-owner-type'], 'USER');
	if (!runOwnerType) {
		throw new Error(`Invalid --to-owner-type "${argv['to-owner-type']}". Must be USER or GROUP.`);
	}

	if (filePath && idsRaw != null) {
		throw new Error('Use either --file or --id/--ids, not both.');
	}
	if ((ownerColumn || toOwnerTypeColumn || nameColumn) && !filePath) {
		throw new Error('--to-owner-column / --to-owner-type-column / --name-column can only be used with --file');
	}
	if (!ownerColumn && singleOwnerId == null) {
		throw new Error('A destination is required: --to-owner, or --to-owner-column together with --file.');
	}
	if (!fromUserId) {
		if (!filePath && idsRaw == null) {
			throw new Error('--from-user is required unless using --file or --id/--ids');
		}
		// No --from-user means there's no previous owner to remove: the listed IDs
		// are simply assigned to the new owner. Every removal path is already guarded
		// by `fromUserId && !keepPreviousOwner`, so this is implicitly keep-previous.
	} else if (!ownerColumn && singleOwnerId != null && runOwnerType === 'USER' && String(fromUserId) === String(singleOwnerId)) {
		throw new Error('--from-user and the destination user must be different');
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

	return {
		fromUserId,
		file: filePath,
		typeColumn,
		idColumn,
		dryRun,
		sendEmail: sendEmailFlag,
		keepPreviousOwner,
		pruneInvalidFunctions,
		verify,
		inputAccessLevel,
		singleOwnerId,
		ownerColumn,
		ownerTypeColumn: toOwnerTypeColumn,
		idsRaw,
		nameColumn,
		runOwnerType,
		requestedTypes,
		mode: filePath ? 'file' : idsRaw != null ? 'ids' : 'user'
	};
}

function optionsFromMeta(meta) {
	const inputAccessLevel = String(meta.inputAccessLevel || 'CAN_VIEW').toUpperCase();
	if (!DATASET_ACCESS_LEVELS.includes(inputAccessLevel)) {
		throw new Error(`The source log has an invalid inputAccessLevel "${meta.inputAccessLevel}".`);
	}
	return {
		fromUserId: meta.fromUserId || null,
		file: meta.file || null,
		typeColumn: meta.typeColumn || null,
		idColumn: meta.idColumn || null,
		dryRun: false,
		sendEmail: Boolean(meta.sendEmail),
		keepPreviousOwner: Boolean(meta.keepPreviousOwner),
		pruneInvalidFunctions: Boolean(meta.pruneInvalidFunctions),
		verify: argv.verify !== undefined ? Boolean(argv.verify) : Boolean(meta.verify),
		inputAccessLevel,
		singleOwnerId: meta.toOwnerId != null ? meta.toOwnerId : null,
		ownerColumn: meta.ownerColumn || null,
		ownerTypeColumn: meta.ownerTypeColumn || null,
		nameColumn: meta.nameColumn || null,
		runOwnerType: meta.toOwnerType || 'USER',
		requestedTypes: Array.isArray(meta.requestedTypes) ? meta.requestedTypes : null,
		mode: meta.mode
	};
}

// Current owner ids of one object, or null when it no longer exists. Returns
// undefined for types without a cheap per-object owner read.
function ownerReader(type) {
	const readFunctionOwner = async (id) => {
		const t = await api.get(`/query/v1/functions/template/${id}?hidden=true`);
		const owner = t.owner && t.owner.id != null ? t.owner.id : t.owner;
		return owner == null ? [] : [String(owner)];
	};
	const readers = {
		'app-studio': async (id) => {
			const a = await api.get(`/content/v1/dataapps/${id}`);
			return (a.owners || []).map((o) => String(o.id));
		},
		'beast-mode': readFunctionOwner,
		card: async (id) => {
			const res = await api.get(`/content/v1/cards?urns=${id}&parts=owners`);
			const arr = Array.isArray(res) ? res : res.cards || [];
			if (arr.length === 0) return null;
			return (arr[0].owners || []).map((o) => String(o.id));
		},
		'custom-app': async (id) => {
			const d = await api.get(`/apps/v1/designs/${id}`);
			if (!d || d.id == null) return null;
			return d.owner == null ? [] : [String(d.owner)];
		},
		dataflow: async (id) => {
			const df = await api.get(`/dataprocessing/v1/dataflows/${id}`);
			return df.responsibleUserId == null ? [] : [String(df.responsibleUserId)];
		},
		dataset: async (id) => {
			const d = await api.get(`/data/v3/datasources/${id}?includeAllDetails=false`);
			const owner = d.owner && d.owner.id != null ? d.owner.id : d.ownerId;
			return owner == null ? [] : [String(owner)];
		},
		page: async (id) => {
			const p = await api.get(`/content/v1/pages/${id}`);
			return (p.owners || []).map((o) => String(o.id));
		},
		variable: readFunctionOwner
	};
	return readers[type];
}

function planKey(entry) {
	return `${entry.type}:${entry.id}:${entry.toOwnerType}:${entry.toOwnerId}`;
}

// Before a replayed transfer, skip anything the source user no longer owns, so a
// stale plan cannot take an object away from whoever owns it now.
async function precheckOwners(filteredByType, fromUserId, rec) {
	const kept = {};
	let changed = 0;
	let unreadable = 0;
	for (const [type, ids] of Object.entries(filteredByType)) {
		const read = ownerReader(type);
		if (!read || ids.length === 0) {
			kept[type] = ids;
			continue;
		}
		kept[type] = [];
		for (const id of ids) {
			const entry = rec.entry(type, id);
			let owners;
			try {
				owners = await read(String(id));
			} catch (err) {
				if (err.status !== 404) {
					rec.log(entry, 'error', { error: `could not confirm the current owner: ${err.message}` });
					unreadable++;
					continue;
				}
				owners = null;
			}
			if (owners === null) {
				rec.log(entry, 'skipped', { reason: 'not-found' });
				changed++;
			} else if (!owners.includes(String(fromUserId))) {
				rec.log(entry, 'skipped', { reason: 'owner-changed', currentOwners: owners });
				changed++;
			} else {
				kept[type].push(id);
			}
		}
	}
	if (changed > 0) console.log(`  ${changed} item(s) skipped: gone, or no longer owned by the source user`);
	if (unreadable > 0) console.log(`  ${unreadable} item(s) not transferred: could not read their current owner`);
	return kept;
}

function printPlanOverview(groups) {
	for (const group of groups) {
		const counts = Object.entries(group.objectsByType).map(([type, ids]) => `${type} ${ids.length}`);
		console.log(`  ${group.toOwnerType} ${group.toUserId}: ${counts.join(', ')}`);
	}
	console.log();
}

// Decide what to do with one beast mode / variable during a transfer.
//
// By default this is a pure ownership change: the links array is echoed back to
// the server exactly as it was read, so only `owner` moves and expression,
// checkSum, legacyId and status are left untouched. Links are NOT inspected,
// because a transfer that silently deletes the thing it was asked to move is a
// footgun — a dead link is a cleanup job, not a reason to destroy a formula
// somebody may still be able to repair.
//
// `pruneInvalid` (--prune-invalid-functions) opts back into the old behaviour:
// unlink dead resources, and delete the formula outright when every link is dead
// or a *visible* link is dead. Only use it when cleanup, not transfer, is the goal.
//
// On a dry run nothing is written; the returned plan still says what would happen
// so the preview can warn about deletions before they happen.
async function processFunctionTemplate(template, toUserId, { pruneInvalid = false, dryRun = false } = {}) {
	if (!pruneInvalid) {
		return {
			deleted: false,
			global: template.global,
			invalidLinks: 0,
			update: { id: template.id, owner: toUserId, links: template.links || [] }
		};
	}

	const { valid, invalid } = await sanitizeLinks(template.links);
	const hasInvalidVisible = invalid.some((l) => l.visible === true);
	const allLinksInvalid = template.links && template.links.length === 1 && invalid.length === 1 && valid.length === 0;

	if (allLinksInvalid || hasInvalidVisible) {
		if (!dryRun) {
			await safe(`delete function ${template.id}`, () => api.del(`/query/v1/functions/template/${template.id}`));
		}
		return { deleted: true, global: template.global, invalidLinks: invalid.length };
	}

	if (invalid.length > 0 && !dryRun) {
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
		invalidLinks: invalid.length,
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

// Print what --prune-invalid-functions did (or would do) to the console instead of
// leaving it in the run log. A "transfer" that destroys formulas has to say so out
// loud, and on a dry run this is the warning that prevents a surprise in the real run.
function reportFunctionSideEffects(label, deletedIds, invalidLinkIds, dryRun) {
	const deleted = deletedIds || [];
	const invalid = invalidLinkIds || [];
	if (deleted.length > 0) {
		console.log(
			`  ${dryRun ? '[DRY RUN] ' : ''}⚠ ${deleted.length} ${label}(s) ${dryRun ? 'would be' : 'were'} DELETED, ` +
				`not transferred, because --prune-invalid-functions is set and every link (or a visible link) is dead: ` +
				`${deleted.join(', ')}`
		);
	}
	if (invalid.length > 0) {
		console.log(
			`  ${invalid.length} ${label}(s) had dead links that ${dryRun ? 'would be' : 'were'} unlinked: ${invalid.join(', ')}`
		);
	}
}

async function reportPublications(fromUserId, _toUserId, filteredIds) {
	const ids = filteredIds.length > 0 ? filteredIds : await listPublications(fromUserId);
	if (ids.length > 0) {
		console.warn(`  (publications cannot be transferred via API; ${ids.length} found but left untouched)`);
	}
	return { transferred: [], skipped: ids.map((id) => ({ id, reason: 'not-transferable' })) };
}

// wasPlanned is false for a given id the handler dropped before planning it.
function resolveItemStatus(entry, wasPlanned, { res, failuresById, thrown, discoveryFailure, dryRun, source, fromUserId }) {
	const { id } = entry;
	const has = (list) => (list || []).some((x) => String(x) === id);
	const failure = (predicate) => lastFailure(failuresById, id, predicate);
	const transferred = res.byType ? res.byType[entry.type] : res.transferred;
	if (has(transferred)) {
		const removal = failure((f) => f.label.startsWith('remove previous'));
		if (removal) {
			return ['error', { error: `new owner added, but removing the previous owner failed: ${removal.message}` }];
		}
		return [dryRun ? 'dry-run' : 'transferred', {}];
	}
	if (has(res.deleted)) {
		if (dryRun) return ['dry-run', { action: 'delete' }];
		const failed = failure();
		return failed ? ['error', { error: failed.message }] : ['deleted', {}];
	}
	const skipped = (res.skipped || []).find((s) => String(s.id) === id);
	if (skipped) return ['skipped', { reason: skipped.reason }];
	if (has(res.adminGrantOnly)) {
		return ['error', { error: 'transfer-owner failed; the new owner only got an ADMIN grant, so ownership did not move' }];
	}
	const failed = failure();
	if (failed) return ['error', { error: failed.message }];
	if (thrown) return ['error', { error: thrown.message }];
	if (wasPlanned) return ['error', { error: 'not transferred' }];
	if (discoveryFailure) {
		return ['error', { error: `could not re-read the source user's items: ${discoveryFailure.message}` }];
	}
	return ['skipped', { reason: source ? 'owner-changed' : fromUserId ? 'not-owned-by-source' : 'not-found' }];
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

// Run one handler (or a coalesced pair of types) and log one row per item it
// planned or was given. Handlers call ctx.onPlanned(items) before their first write.
async function runTracked({ label, filteredByType, execute, ctx, rec, summary }) {
	console.log(`\n=== ${label} ===`);
	activeType = label;
	const types = Object.keys(filteredByType);
	for (const type of types) rec.count(type);
	const byType = ctx.checkOwner ? await precheckOwners(filteredByType, ctx.fromUserId, rec) : filteredByType;

	const typeOfGiven = new Map();
	for (const [type, ids] of Object.entries(byType)) {
		for (const id of ids) typeOfGiven.set(String(id), type);
	}
	const planned = new Map();
	const errStart = failures.length;
	let planStart = null;
	const onPlanned = (items) => {
		if (planStart === null) planStart = failures.length;
		const fresh = [];
		for (const item of items) {
			const fields = item !== null && typeof item === 'object' ? item : { id: item };
			const entry = rec.entry(typeOfGiven.get(String(fields.id)) || fields.type || types[0], fields);
			const key = planKey(entry);
			if (planned.has(key)) continue;
			planned.set(key, entry);
			fresh.push(entry);
		}
		ctx.beginPlanned(fresh);
	};

	// Handlers treat an empty id list as "discover everything", so an id list the
	// pre-check emptied must not reach them.
	const wasFiltered = types.some((t) => filteredByType[t].length > 0);
	const nothingLeft = wasFiltered && types.every((t) => byType[t].length === 0);
	let res = {};
	let thrown = null;
	try {
		if (!nothingLeft) res = (await execute(byType, { ...ctx, onPlanned })) || {};
	} catch (err) {
		thrown = err;
		console.error(`  ✗ ${label} failed: ${err.message}`);
	}
	const errors = failures.slice(errStart);
	const itemIds = new Set([...[...planned.values()].map((e) => e.id), ...typeOfGiven.keys()]);
	const discoveryFailures = failures
		.slice(errStart, planStart === null ? failures.length : planStart)
		.filter((failure) => ![...failureIds(failure)].some((id) => itemIds.has(id)));
	const outcome = {
		res,
		failuresById: indexFailures(errors),
		thrown,
		discoveryFailure: discoveryFailures[0] || null,
		dryRun: ctx.dryRun,
		source: ctx.source,
		fromUserId: ctx.fromUserId
	};
	const tally = {};
	const logItem = (entry, wasPlanned) => {
		const [status, extra] = resolveItemStatus(entry, wasPlanned, outcome);
		rec.log(entry, status, extra);
		const shown = extra.action === 'delete' ? 'to delete' : status;
		tally[entry.type] = tally[entry.type] || {};
		tally[entry.type][shown] = (tally[entry.type][shown] || 0) + 1;
	};
	for (const entry of planned.values()) logItem(entry, true);
	for (const [type, ids] of Object.entries(byType)) {
		for (const id of ids) {
			const entry = rec.entry(type, id);
			const key = planKey(entry);
			if (planned.has(key)) continue;
			planned.set(key, entry);
			logItem(entry, false);
		}
	}

	for (const failure of discoveryFailures) {
		rec.log(rec.typeRow(types[0]), 'error', { phase: 'discover', error: `${failure.label}: ${failure.message}` });
	}
	if (thrown && planned.size === 0) rec.log(rec.typeRow(types[0]), 'error', { phase: 'discover', error: thrown.message });

	const doneStatus = ctx.dryRun ? 'dry-run' : 'transferred';
	if (Object.keys(tally).length === 0) console.log(`  → 0 ${ctx.dryRun ? 'planned' : 'transferred'}`);
	for (const [type, counts] of Object.entries(tally)) {
		const rest = Object.entries(counts)
			.filter(([status]) => status !== doneStatus)
			.map(([status, n]) => `${n} ${status}`);
		const done = `${counts[doneStatus] || 0} ${ctx.dryRun ? 'planned' : 'transferred'}`;
		console.log(`  → ${type}: ${done}${rest.length > 0 ? ` (${rest.join(', ')})` : ''}`);
	}
	if (errors.length > 0) console.log(`  ⚠ ${errors.length} error(s) logged, see run log`);
	if ((res.adminGrantOnly || []).length > 0) {
		console.log(`  ⚠ ${res.adminGrantOnly.length} got only an ADMIN grant, ownership did NOT move`);
	}

	const details = {};
	if (res.inputAccess) details.inputAccess = res.inputAccess;
	for (const key of ['invalidLinkBeastModes', 'invalidLinkVariables']) {
		if ((res[key] || []).length > 0) details[key] = res[key];
	}
	if (Object.keys(details).length > 0) summary.details.push({ ...rec.typeRow(types[0]), type: label, ...details });
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

// Email the new owner a summary of everything that was transferred to them, with
// the full per-object list attached as an .xlsx (mirrors domo-toolkit's ownership
// flow). Uses Domo's social messaging endpoint: POST
// /social/v3/messages/domoWrapperNew:plainText/send with the recipient routed
// both by email (query param) and user/group ID (body), so it lands even if the
// email lookup fails. The HTML body is wrapped in the same Helvetica flex-column
// styling the toolkit/Code Engine helpers use.
async function sendTransferEmail({ toUserId, toOwnerType, toUserName, fromUserId, fromUserName, transferredByType, objectNames }) {
	const types = Object.entries(transferredByType).filter(([, ids]) => ids && ids.length > 0);
	if (types.length === 0) {
		console.log('  Nothing was transferred — skipping email.');
		return;
	}

	const isGroup = toOwnerType === 'GROUP';
	const total = types.reduce((sum, [, ids]) => sum + ids.length, 0);
	// Groups have no single email address; route them by recipientsGroupIds and
	// let Domo fan the message out to the group's members.
	const email = isGroup ? null : await getUserEmail(toUserId);

	// Build the transfer-log attachment: one row per transferred object, mirroring
	// the column shape domo-toolkit emails. "Object Name" is included only when a
	// --name-column supplied names (objectNames); "Notes" is always omitted (per-
	// object failure reasons aren't tracked here). Upload it as a data file; its ID
	// goes in dataFileAttachments.
	const date = new Date().toISOString().slice(0, -5);
	const includeNames = Boolean(objectNames);
	const columns = [
		'Object Type',
		'Object ID',
		...(includeNames ? ['Object Name'] : []),
		'Date',
		'Status',
		'Previous Owner ID',
		'Previous Owner Name',
		'New Owner ID',
		'New Owner Name'
	];
	const aoa = [columns];
	for (const [type, ids] of types) {
		for (const id of ids) {
			aoa.push([
				String(type).toUpperCase(),
				id,
				...(includeNames ? [objectNames.get(`${type}:${id}`) ?? ''] : []),
				date,
				'TRANSFERRED',
				fromUserId || '',
				fromUserName || '',
				toUserId,
				toUserName
			]);
		}
	}
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Transfer Log');
	const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
	const filename = `transferred-objects_${date.replace(/[:-]/g, '').replace('T', '_')}.xlsx`;
	const dataFileId = await uploadDataFile(
		buffer,
		filename,
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
	);

	const fromClause = fromUserName ? ` previously owned by ${escapeHtml(fromUserName)}` : '';
	let bodyHtml = `<h2 style="text-align: left;">Content transferred to you</h2>`;
	bodyHtml += `<p style="text-align: left;">Hi ${escapeHtml(toUserName)},</p>`;
	bodyHtml += `<p style="text-align: left;">You are now the owner of ${total} item(s)${fromClause}, broken down below.</p>`;
	bodyHtml += `<ul style="text-align: left;">${types.map(([type, ids]) => `<li>${escapeHtml(type)}: ${ids.length}</li>`).join('')}</ul>`;
	if (dataFileId != null) {
		bodyHtml += `<p style="text-align: left;">A complete list of the transferred items is attached (${escapeHtml(filename)}).</p>`;
	}

	const payload = {
		subject: 'Domo content transferred to you',
		text: `<div style="display: flex; flex-direction: column; font-family: Helvetica; overflow-x: auto; flex-wrap: wrap; width: 100%; text-align: center;"><div style="display: flex; flex-direction: column; justify-content: center; width: 100%">${bodyHtml}</div></div>`,
		recipientsUserIds: isGroup ? [] : [parseInt(toUserId, 10)],
		recipientsGroupIds: isGroup ? [parseInt(toUserId, 10)] : [],
		dataFileAttachments: dataFileId != null ? [dataFileId] : [],
		populateReplyToHeaderWithRecipients: false
	};

	const url = `/social/v3/messages/domoWrapperNew:plainText/send?route=recipients&method=EMAIL&recipients=${encodeURIComponent(
		email || ''
	)}`;
	// safe() logs and records any failure (into `failures`) and returns null, so
	// only announce success when nothing was recorded for this send.
	await safe('send transfer email', () => api.post(url, { parameters: payload }), { toUserId, recipientEmail: email });
	if (!failures.some((f) => f.label === 'send transfer email')) {
		const attachNote = dataFileId != null ? ' with an attached list' : ' (attachment upload failed — see log)';
		console.log(`  → Emailed ${toUserName}${email ? ` (${email})` : ''} a summary of ${total} transferred item(s)${attachNote}.`);
	}
}

// Record + announce that a user-only type can't accept the current GROUP
// destination. `ids` is the filtered list for the type ([] in discover-all mode).
function skipGroupOwner(type, ids, summary) {
	console.log(`\n=== ${type} ===`);
	console.warn(`  Type "${type}" does not support group ownership; skipping${ids.length ? ` ${ids.length}` : ''} item(s).`);
	summary.skipped.push({ type, ids, reason: 'group-owner-unsupported' });
}

// A log row back to the entry a replay acts on; rows without an item id are dropped.
function toPlanEntry(row) {
	if (!row.type || row.id == null || row.toOwnerId == null || !row.toOwnerType) return null;
	const { action: _action, currentOwners: _currentOwners, ...entry } = stripStatus(row);
	return entry;
}

async function transferAccounts(fromUserId, toUserId, filteredIds, { dryRun, onPlanned }) {
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
	onPlanned(ids);
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

async function transferAiModels(fromUserId, toUserId, filteredIds, { dryRun, onPlanned }) {
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
	onPlanned(ids);
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

async function transferAiProjects(fromUserId, toUserId, filteredIds, { dryRun, onPlanned }) {
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
	onPlanned(ids);
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

async function transferAlerts(fromUserId, toUserId, filteredIds, { dryRun, onPlanned }) {
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
	onPlanned(ids);
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

async function transferAppDbCollections(fromUserId, toUserId, filteredIds, { dryRun, onPlanned }) {
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
	onPlanned(ids);
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

async function transferApprovals(fromUserId, toUserId, filteredIds, { dryRun, onPlanned, restrictTo }) {
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
	const inPlan = (e) => !restrictTo || restrictTo.has(String(e.node.approval.id));
	const pending = edges.filter((e) => e.node.approval.status === 'PENDING' && inPlan(e)).map((e) => e.node.approval);
	const skipped = edges
		.filter((e) => e.node.approval.status === 'SENTBACK' && inPlan(e))
		.map((e) => ({ id: e.node.approval.id, reason: 'sent-back' }));

	if (pending.length === 0) return { transferred: [], skipped };
	onPlanned(pending.map(({ id, version }) => ({ id, version })));
	if (dryRun) return { transferred: pending.map((p) => p.id), skipped };

	const transferred = [];
	for (const { id, version } of pending) {
		const replaced = await attempt(`replace approver on ${id}`, () =>
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
		if (replaced.ok) transferred.push(id);
	}
	return { transferred, skipped };
}

async function transferApprovalTemplates(fromUserId, toUserId, filteredIds, { dryRun, onPlanned, restrictTo }) {
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
	const templateIds = edges.map((e) => e.node.id).filter((id) => !restrictTo || restrictTo.has(String(id)));
	if (templateIds.length === 0) return { transferred: [] };
	onPlanned(templateIds);
	if (dryRun) return { transferred: templateIds };

	const getTemplateQuery =
		'query getTemplateForEdit($id: ID!) {\n  template(id: $id) {\n    id\n    title\n    titleName\n    titlePlaceholder\n    acknowledgment\n    instructions\n    description\n    providerName\n    isPublic\n    chainIsLocked\n    type\n    isPublished\n    observers { id type ... on Group { userCount isDeleted } ... on User { isDeleted } }\n    categories { id name }\n    owner { id }\n    fields { key type name data placeholder required isPrivate ... on SelectField { option multiselect datasource column order } }\n    approvers { type key ... on ApproverPerson { approverId userDetails { id isDeleted } } ... on ApproverGroup { approverId groupDetails { id isDeleted } } ... on ApproverPlaceholder { placeholderText } }\n    workflowIntegration { modelId modelVersion startName modelName parameterMapping { fields { field parameter required type } } }\n  }\n}';

	const saveTemplateMutation =
		'mutation saveTemplate($template: TemplateInput!) { template: saveTemplate(template: $template) { id } }';

	const transferred = [];
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

		const saved = await attempt(`save template ${id}`, () =>
			api.post(url, {
				operationName: 'saveTemplate',
				variables: { template: clean },
				query: saveTemplateMutation
			})
		);
		if (saved.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferAppStudioApps(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner, onPlanned, toOwnerType }) {
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
	onPlanned(ids);
	if (dryRun) return { transferred: ids };

	const transferred = await reassignOwnersInBatches(ids, {
		label: 'app studio app',
		addOwner: (entityIds) =>
			api.put('/content/v1/dataapps/bulk/owners', {
				note: '',
				entityIds,
				owners: [{ type: toOwnerType, id: parseInt(toUserId, 10) }],
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

async function transferCards(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner, onPlanned, toOwnerType }) {
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
	onPlanned(ids);
	if (dryRun) return { transferred: ids };

	// POST /content/v1/cards/owners/{action} — action is "add" or "remove";
	// same body shape for both. The new owner may be a USER or GROUP; the previous
	// owner being removed is always the --from-user (a USER).
	const updateOwners = (action, cardIds, ownerId, ownerType) =>
		api.post(`/content/v1/cards/owners/${action}`, {
			cardIds,
			cardOwners: [{ id: ownerId, type: ownerType }],
			note: '',
			sendEmail: false
		});

	// Cards allow multiple owners, so adding the new owner only makes them a
	// co-owner; the previous owner is removed afterward from the cards that
	// successfully got the new owner — unless --keep-previous-owner (or no
	// --from-user), in which case the old owner stays attached.
	const transferred = await reassignOwnersInBatches(ids, {
		label: 'card',
		addOwner: (cardIds) => updateOwners('add', cardIds, toUserId, toOwnerType),
		removeOldOwner:
			fromUserId && !keepPreviousOwner ? (cardIds) => updateOwners('remove', cardIds, fromUserId, 'USER') : null
	});
	return { transferred };
}

async function transferCodeEnginePackages(fromUserId, toUserId, filteredIds, { dryRun, onPlanned }) {
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
	onPlanned(ids);
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

async function transferCustomApps(fromUserId, toUserId, filteredIds, { dryRun, onPlanned }) {
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
	const brickIds = new Set(bricks.map(String));
	onPlanned(ownedByUser.map((id) => ({ id, kind: brickIds.has(String(id)) ? 'brick' : 'pro-code' })));
	if (dryRun) return { transferred: ownedByUser, bricks, proCodeApps };

	const transferred = [];
	const adminGrantOnly = [];
	for (const id of ownedByUser) {
		const res = await attempt(`transfer app design ${id}`, () =>
			api.put(`/apps/v1/designs/${id}/transfer-owner`, { newOwner: String(toUserId) })
		);
		if (res.ok) {
			transferred.push(id);
			continue;
		}
		// An ADMIN grant does NOT move `owner`, so these are reported separately
		// rather than counted as transfers.
		const granted = await attempt(`grant admin to new owner on app ${id}`, () =>
			api.post(`/apps/v1/designs/${id}/permissions/ADMIN`, [toUserId])
		);
		if (granted.ok) adminGrantOnly.push(id);
	}
	return { transferred, adminGrantOnly, bricks, proCodeApps };
}

async function transferDataflows(
	fromUserId,
	toUserId,
	filteredIds,
	{ dryRun, fromUserName, inputAccessLevel, onPlanned }
) {
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
	onPlanned(ids);

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

async function transferDatasets(fromUserId, toUserId, filteredIds, { dryRun, fromUserName, onPlanned, toOwnerType }) {
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

	onPlanned(ids);
	if (dryRun) return { transferred: ids };

	const reassignBatch = (dsIds) =>
		api.put('/data/ui/v3/datasources/ownedBy', [
			{
				entityIdentifier: { id: parseInt(toUserId, 10), type: toOwnerType },
				dataSourceIds: dsIds
			}
		]);
	// The per-dataset responsibleUsers endpoint is USER-only, so it's only a valid
	// retry path for a user owner; for a GROUP owner, retry via the same bulk
	// ownedBy endpoint one ID at a time.
	const reassignOne =
		toOwnerType === 'GROUP'
			? (id) => reassignBatch([id])
			: (id) => api.put(`/data/v2/datasources/${id}/responsibleUsers`, { responsibleUserId: String(toUserId) });

	// Reassign in batches. When a batch fails, retry each dataset on its own — for
	// a user owner via the per-dataset endpoint (a different code path that can
	// succeed where the batch choked); the per-ID failures pinpoint which datasets
	// are the problem. transferred tracks only what actually went through, so the
	// count and tagging stay honest.
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

async function transferFilesets(fromUserId, toUserId, filteredIds, { dryRun, onPlanned }) {
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
	onPlanned(ids);
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

// Run the full per-type transfer for a single destination owner (once per group).
// Logs one row per item and returns the type → transferred-IDs map for --verify
// and --send-email.
async function transferForUser({ ctx, objectsByType, requestedTypes, logger, summary }) {
	const { fromUserId, toUserId, toOwnerType } = ctx;
	const typesToProcess = objectsByType ? Object.keys(objectsByType) : requestedTypes || ALL_TYPES;
	const transferredByType = {};
	const rec = createRecorder({ ctx, logger, summary, transferredByType });
	const idsFor = (type) => [...((objectsByType && objectsByType[type]) || [])];
	const pick = (types) => Object.fromEntries(types.filter((t) => typesToProcess.includes(t)).map((t) => [t, idsFor(t)]));
	const track = (label, filteredByType, execute) => runTracked({ label, filteredByType, execute, ctx, rec, summary });
	const skipGroup = (type) => {
		skipGroupOwner(type, idsFor(type), summary);
		rec.skipIds(type, idsFor(type), 'group-owner-unsupported');
	};

	for (const type of typesToProcess) {
		const filtered = idsFor(type);

		if (objectsByType && filtered.length === 0) continue;
		const rediscover = Boolean(objectsByType) && DISCOVERY_ONLY_TYPES.has(type);
		if (rediscover && !(ctx.source && fromUserId)) {
			console.log(`\n=== ${type} ===`);
			console.warn(
				`  Type "${type}" only supports discovery from --from-user; skipping ${filtered.length} filtered ID(s).`
			);
			summary.skipped.push({ type, ids: filtered, reason: 'discovery-only' });
			rec.skipIds(type, filtered, 'discovery-only');
			continue;
		}

		if (COALESCED_TYPES.has(type)) continue; // handled below

		if (toOwnerType === 'GROUP' && !GROUP_CAPABLE_TYPES.has(type)) {
			skipGroup(type);
			continue;
		}

		await track(type, { [type]: filtered }, async (ids, runCtx) => {
			if (!rediscover) return HANDLERS[type](fromUserId, toUserId, ids[type], runCtx);
			console.log(`  Re-reading what the source user owns; only the ${ids[type].length} planned item(s) are acted on.`);
			return HANDLERS[type](fromUserId, toUserId, [], { ...runCtx, restrictTo: new Set(ids[type].map(String)) });
		});
	}

	// Beast modes + variables share transferFunctions — call it once. Both are
	// user-only, so a GROUP destination skips them.
	const beastSelected = typesToProcess.includes('beast-mode');
	const varSelected = typesToProcess.includes('variable');
	if ((beastSelected || varSelected) && toOwnerType === 'GROUP') {
		if (beastSelected) skipGroup('beast-mode');
		if (varSelected) skipGroup('variable');
	} else if (beastSelected || varSelected) {
		await track('beast-mode / variable', pick(['beast-mode', 'variable']), async (ids, runCtx) => {
			const combinedIds = [...(ids['beast-mode'] || []), ...(ids.variable || [])];
			const res = await transferFunctions(fromUserId, toUserId, combinedIds, runCtx);
			reportFunctionSideEffects('beast mode', res.deletedBeastModes, res.invalidLinkBeastModes, ctx.dryRun);
			reportFunctionSideEffects('variable', res.deletedVariables, res.invalidLinkVariables, ctx.dryRun);
			return res;
		});
	}

	// Projects + project-tasks share a single API flow; handle them together. Both
	// are user-only, so a GROUP destination skips them.
	const projectsSelected = typesToProcess.includes('project');
	const taskSelected = typesToProcess.includes('project-task');
	if ((projectsSelected || taskSelected) && toOwnerType === 'GROUP') {
		if (projectsSelected) skipGroup('project');
		if (taskSelected) skipGroup('project-task');
	} else if (projectsSelected || taskSelected) {
		await track('project / project-task', pick(['project', 'project-task']), async (ids, runCtx) => {
			const res = await transferProjectsAndTasks(fromUserId, toUserId, ids.project || [], ids['project-task'] || [], runCtx);
			return { ...res, byType: { project: res.projects, 'project-task': res.tasks } };
		});
	}

	return transferredByType;
}

async function transferFunctions(fromUserId, toUserId, filteredIds, { dryRun, onPlanned, pruneInvalidFunctions }) {
	const bulkUrl = '/query/v1/functions/bulk/template';
	const transferred = { beastMode: [], variable: [] };
	const deleted = { beastMode: [], variable: [] };
	const withInvalidLinks = { beastMode: [], variable: [] };

	const handleTemplate = async (template) => {
		const result = await processFunctionTemplate(template, toUserId, {
			dryRun,
			pruneInvalid: pruneInvalidFunctions
		});
		const bucket = result.global === false ? 'beastMode' : 'variable';
		if (result.invalidLinks > 0) withInvalidLinks[bucket].push(template.id);
		if (result.deleted) deleted[bucket].push(template.id);
		else return { bucket, update: result.update };
		return null;
	};

	const buildResult = () => ({
		transferred: [...transferred.beastMode, ...transferred.variable],
		deleted: [...deleted.beastMode, ...deleted.variable],
		deletedBeastModes: deleted.beastMode,
		deletedVariables: deleted.variable,
		beastModes: transferred.beastMode,
		invalidLinkBeastModes: withInvalidLinks.beastMode,
		invalidLinkVariables: withInvalidLinks.variable,
		variables: transferred.variable
	});

	const applyUpdates = async (updates) => {
		for (const bucket of ['beastMode', 'variable']) {
			for (let i = 0; i < updates[bucket].length; i += 100) {
				const chunk = updates[bucket].slice(i, i + 100);
				const ids = chunk.map((u) => u.id);
				const res = dryRun
					? { ok: true }
					: await attempt(`bulk update ${bucket} ${i + 1}-${i + chunk.length}`, () => api.post(bulkUrl, { update: chunk }), {
							ids
						});
				if (res.ok) transferred[bucket].push(...ids);
			}
		}
	};

	if (filteredIds.length > 0) {
		// A dry run still reads each template: the reads are harmless and they let the
		// preview report the real beast-mode/variable split, and name the formulas that
		// --prune-invalid-functions would DELETE rather than move.
		onPlanned(filteredIds);
		const updates = { beastMode: [], variable: [] };
		for (const fid of filteredIds) {
			const template = await safe(`get function ${fid}`, () =>
				api.get(`/query/v1/functions/template/${fid}?hidden=true`)
			);
			if (!template) continue;
			const out = await handleTemplate(template);
			if (out) updates[out.bucket].push(out.update);
		}
		await applyUpdates(updates);
	} else {
		// The owner search sorted by name is NOT stable: equal names reorder between page
		// requests, so offset paging duplicates and misses ids even when nothing changes.
		// Dedupe by id and repeat whole passes until one turns up no new id.
		const limit = 100;
		const attempted = new Set();
		const MAX_PASSES = 10;
		for (let pass = 1; pass <= MAX_PASSES; pass++) {
			const found = new Map();
			for (let offset = 0; ; offset += limit) {
				const res = await safe(`search functions pass ${pass} offset=${offset}`, () =>
					api.post('/query/v1/functions/search', {
						filters: [{ field: 'owner', idList: [fromUserId] }],
						sort: { field: 'name', ascending: true },
						limit,
						offset
					})
				);
				const rows = (res && res.results) || [];
				for (const t of rows) if (!found.has(String(t.id))) found.set(String(t.id), t);
				if (rows.length === 0 || !res || !res.hasMore) break;
			}
			if (found.size === 0) break;

			const fresh = [...found.values()].filter((t) => !attempted.has(String(t.id)));
			if (fresh.length === 0) {
				if (!dryRun) {
					// Everything still showing up was already tried and did not move; the
					// failures are in the run log.
					console.log(`  ${found.size} function(s) still owned by the source after ${pass - 1} pass(es)`);
				}
				break;
			}
			if (pass > 1) console.log(`  Pass ${pass} found ${fresh.length} more function(s)`);
			for (const t of fresh) attempted.add(String(t.id));
			onPlanned(fresh.map((t) => ({ id: t.id, type: t.global === false ? 'beast-mode' : 'variable' })));

			const updates = { beastMode: [], variable: [] };
			for (const template of fresh) {
				const out = await handleTemplate(template);
				if (out) updates[out.bucket].push(out.update);
			}
			await applyUpdates(updates);
		}
	}

	return buildResult();
}

async function transferGoals(fromUserId, toUserId, filteredIds, { dryRun, onPlanned, restrictTo }) {
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

	const goals = restrictTo ? allGoals.filter((g) => restrictTo.has(String(g.id))) : allGoals;
	if (goals.length === 0) return { transferred: [] };
	onPlanned(goals.map((g) => g.id));
	if (dryRun) return { transferred: goals.map((g) => g.id) };

	const transferred = [];
	for (const goal of goals) {
		goal.ownerId = toUserId;
		goal.owners = [{ ownerId: toUserId, ownerType: 'USER', primary: false }];
		const res = await attempt(`update goal ${goal.id}`, () => api.put(`/social/v1/objectives/${goal.id}`, goal));
		if (res.ok) transferred.push(goal.id);
	}
	return { transferred };
}

async function transferGroups(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner, onPlanned }) {
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
	onPlanned(ids);
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

async function transferJupyterWorkspaces(fromUserId, toUserId, filteredIds, { dryRun, onPlanned }) {
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
	onPlanned(ids);
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

async function transferMetrics(fromUserId, toUserId, filteredIds, { dryRun, onPlanned }) {
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
	onPlanned(ids);
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const res = await attempt(`reassign metric ${id}`, () => api.post(`/content/v1/metrics/${id}/owner/${toUserId}`));
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferPages(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner, onPlanned, toOwnerType }) {
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
	onPlanned(ids);
	if (dryRun) return { transferred: ids };

	const transferred = await reassignOwnersInBatches(ids, {
		label: 'page',
		addOwner: (pageIds) =>
			api.put('/content/v1/pages/bulk/owners', {
				owners: [{ id: toUserId, type: toOwnerType }],
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

async function transferProjectsAndTasks(fromUserId, toUserId, filteredProjectIds, filteredTaskIds, { dryRun, onPlanned }) {
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

	const ownedProjects = projects.filter((p) => !fromUserId || p.assignedTo == fromUserId);
	onPlanned([
		...ownedProjects.map((p) => ({ id: p.id, type: 'project' })),
		...tasks.map((t) => ({ id: t.id, type: 'project-task' }))
	]);

	if (dryRun) {
		return {
			transferred: [...ownedProjects.map((p) => p.id), ...tasks.map((t) => t.id)],
			projects: ownedProjects.map((p) => p.id),
			tasks: tasks.map((t) => t.id)
		};
	}

	const assignedBy = fromUserId || toUserId;
	const transferredTaskIds = [];
	for (const task of tasks) {
		if (!fromUserId || task.primaryTaskOwner == fromUserId) task.primaryTaskOwner = toUserId;
		task.contributors = task.contributors || [];
		task.owners = task.owners || [];
		// A retry can revisit a task the interrupted run already updated.
		if (!task.contributors.some((c) => c.assignedTo == toUserId)) task.contributors.push({ assignedTo: toUserId, assignedBy });
		if (!task.owners.some((o) => o.assignedTo == toUserId)) task.owners.push({ assignedTo: toUserId, assignedBy });
		const res = await attempt(`update task ${task.id}`, () => api.put(`/content/v1/tasks/${task.id}`, task));
		if (res.ok) transferredTaskIds.push(task.id);
	}

	const transferredProjectIds = [];
	for (const project of ownedProjects) {
		const res = await attempt(`update project ${project.id}`, () =>
			api.put(`/content/v1/projects/${project.id}`, {
				id: project.id,
				creator: toUserId
			})
		);
		if (res.ok) transferredProjectIds.push(project.id);
	}
	return {
		transferred: [...transferredProjectIds, ...transferredTaskIds],
		projects: transferredProjectIds,
		tasks: transferredTaskIds
	};
}

async function transferRepositories(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner, onPlanned }) {
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
	onPlanned(ids);
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

async function transferScheduledReports(fromUserId, toUserId, filteredIds, { checkOwner, dryRun, onPlanned }) {
	// When no filtered list is supplied we have no cheap way to list this user's
	// scheduled reports without a domostats dataset, so tell the caller.
	let ids = filteredIds;
	if (ids.length === 0) {
		console.warn('  (scheduled-report discovery requires a domostats dataset and is not implemented here; skipping)');
		return { transferred: [] };
	}
	onPlanned(ids);
	if (dryRun) return { transferred: ids };

	const transferred = [];
	const skipped = [];
	for (const id of ids) {
		const report = await safe(`get report ${id}`, () => api.get(`/content/v1/reportschedules/${id}`));
		if (!report) continue;
		if (checkOwner && String(report.ownerId) !== String(fromUserId)) {
			skipped.push({ id, reason: 'owner-changed' });
			continue;
		}
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
	return { transferred, skipped };
}

async function transferSubscriptions(fromUserId, toUserId, filteredIds, { dryRun, onPlanned }) {
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
	onPlanned(
		toTransfer.map((s) => ({
			id: s.subscription.id,
			publicationId: s.subscription.publicationId,
			domain: s.subscription.domain,
			customerId: s.subscription.customerId,
			shareUsers: s.shareUsers,
			shareGroups: s.shareGroups
		}))
	);
	if (dryRun) return { transferred: toTransfer.map((s) => s.subscription.id) };

	const transferred = [];
	for (const sub of toTransfer) {
		const sid = sub.subscription.id;
		const res = await attempt(`update subscription ${sid}`, () =>
			api.put(`/publish/v2/subscriptions/${sid}`, {
				publicationId: sub.subscription.publicationId,
				domain: sub.subscription.domain,
				customerId: sub.subscription.customerId,
				userId: toUserId,
				userIds: sub.shareUsers,
				groupIds: sub.shareGroups
			})
		);
		if (res.ok) transferred.push(sid);
	}
	return { transferred };
}

async function transferTaskCenterQueues(fromUserId, toUserId, filteredIds, { dryRun, onPlanned }) {
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
	onPlanned(ids);
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		const res = await attempt(`set queue ${id} owner`, () => api.put(`/queues/v1/${id}/owner/${toUserId}`));
		if (res.ok) transferred.push(id);
	}
	return { transferred };
}

async function transferTaskCenterTasks(fromUserId, toUserId, filteredIds, { dryRun, onPlanned, planFields }) {
	let tasks;
	if (filteredIds.length > 0) {
		// CSV-supplied task IDs carry no queueId, so only replayed log entries can be reassigned.
		tasks = filteredIds.map((id) => ({ id, queueId: (planFields && planFields.get(`task:${id}`)?.queueId) || null }));
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
	const skipped = [];
	const assignable = [];
	for (const t of tasks) {
		if (t.queueId) {
			assignable.push(t);
		} else {
			console.warn(`  - task ${t.id}: queueId unknown, cannot reassign`);
			skipped.push({ id: t.id, reason: 'queue-unknown' });
		}
	}
	if (assignable.length === 0) return { transferred: [], skipped };
	onPlanned(assignable);
	if (dryRun) return { transferred: assignable.map((t) => t.id), skipped };

	const transferred = [];
	for (const t of assignable) {
		const res = await attempt(`reassign task ${t.id}`, () =>
			api.put(`/queues/v1/${t.queueId}/tasks/${t.id}/assign`, {
				userId: toUserId,
				type: 'USER',
				taskIds: [t.id]
			})
		);
		if (res.ok) transferred.push(t.id);
	}
	return { transferred, skipped };
}

async function transferWorkflows(fromUserId, toUserId, filteredIds, { checkOwner, dryRun, onPlanned }) {
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
	onPlanned(ids);
	if (dryRun) return { transferred: ids };

	const transferred = [];
	const skipped = [];
	for (const id of ids) {
		const workflow = await safe(`get workflow ${id}`, () => api.get(`/workflow/v1/models/${id}`));
		if (!workflow) continue;
		if (checkOwner && String(workflow.owner) !== String(fromUserId)) {
			skipped.push({ id, reason: 'owner-changed' });
			continue;
		}
		workflow.owner = String(toUserId);
		const res = await attempt(`update workflow ${id}`, () => api.put(`/workflow/v1/models/${id}`, workflow));
		if (res.ok) transferred.push(id);
	}
	return { transferred, skipped };
}

// Worksheets live on the same DATA_APP backend as App Studio apps and share
// the /dataapps/bulk/owners endpoints; the adminsummary `type` filter is what
// separates them.
async function transferWorksheets(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner, onPlanned, toOwnerType }) {
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
	onPlanned(ids);
	if (dryRun) return { transferred: ids };

	const transferred = await reassignOwnersInBatches(ids, {
		label: 'worksheet',
		addOwner: (entityIds) =>
			api.put('/content/v1/dataapps/bulk/owners', {
				note: '',
				entityIds,
				owners: [{ type: toOwnerType, id: parseInt(toUserId, 10) }],
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
async function transferWorkspaces(fromUserId, toUserId, filteredIds, { dryRun, keepPreviousOwner, onPlanned, toOwnerType }) {
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
	onPlanned(ids);
	if (dryRun) return { transferred: ids };

	const transferred = [];
	for (const id of ids) {
		try {
			const raw = await api.get(`/nav/v1/workspaces/${id}/members`);
			const members = Array.isArray(raw) ? raw : (raw && raw.members) || [];

			const destMember = members.find((m) => m.memberType === toOwnerType && m.memberId === toUserId);
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
					members: [{ memberId: toUserId, memberRole: 'OWNER', memberType: toOwnerType }],
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

// Upload a Buffer as a Domo data file and return its numeric ID, for use as an
// email attachment (dataFileAttachments). Mirrors domo-toolkit's files service:
// POST /data/v1/data-files with the raw binary body (not multipart). Uses a raw
// fetch because the shared api client assumes JSON. Returns null on failure
// (recorded via safe()) so the email still sends without the attachment.
async function uploadDataFile(buffer, filename, mimeType) {
	const url = `${config.baseUrl}/data/v1/data-files?name=${encodeURIComponent(filename)}&public=false`;
	return safe(
		`upload attachment ${filename}`,
		async () => {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'X-DOMO-Developer-Token': config.accessToken, 'Content-Type': mimeType },
				body: buffer
			});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}: ${await res.text()}`);
			}
			const data = await res.json();
			return data.dataFileId;
		},
		{ filename }
	);
}

// Re-read every transferred object and confirm the owner actually moved. Domo
// reports success on the write call, and the search index that discovery uses lags
// behind ownership writes by minutes, so "the command said 75" and "75 objects
// changed hands" are different claims. This checks the second one, per object,
// against the live API.
//
// Only types with a known, cheap per-object owner read are checked; anything else
// is reported as unverified rather than quietly counted as fine.
async function verifyTransfers({ transferredByType, toUserId, toOwnerType, fromUserId, keepPreviousOwner }) {
	const expectOldOwnerGone = Boolean(fromUserId) && !keepPreviousOwner;
	const want = String(toUserId);

	console.log('\n=== verify ===');
	activeType = 'verify';
	let confirmed = 0;
	const problems = [];
	const unverified = [];

	for (const [type, ids] of Object.entries(transferredByType)) {
		if (!ids || ids.length === 0) continue;
		const read = ownerReader(type);
		if (!read) {
			unverified.push({ type, count: ids.length });
			continue;
		}
		// A GROUP destination lands as a group id in the owner list for the types that
		// accept one, so the same identity check covers both kinds of owner.
		let ok = 0;
		for (const id of ids) {
			let owners;
			try {
				owners = await read(String(id));
			} catch (err) {
				problems.push({ type, id: String(id), issue: `could not re-read: ${err.message.slice(0, 120)}` });
				continue;
			}
			if (owners === null) {
				problems.push({ type, id: String(id), issue: 'object not found after transfer' });
			} else if (owners.length === 0) {
				problems.push({ type, id: String(id), issue: 'OWNERLESS after transfer' });
			} else if (!owners.includes(want)) {
				problems.push({
					type,
					id: String(id),
					issue: `new owner ${toOwnerType} ${want} absent; owners are ${owners.join('|')}`
				});
			} else if (expectOldOwnerGone && owners.includes(String(fromUserId))) {
				problems.push({
					type,
					id: String(id),
					issue: `previous owner ${fromUserId} still present; owners are ${owners.join('|')}`
				});
			} else {
				ok++;
				confirmed++;
			}
			await new Promise((r) => setTimeout(r, 60));
		}
		console.log(`  ${type}: ${ok}/${ids.length} confirmed`);
	}

	for (const u of unverified) console.log(`  ${u.type}: ${u.count} transferred, not verifiable by --verify`);
	if (problems.length > 0) {
		console.log(`  ⚠ ${problems.length} problem(s):`);
		for (const p of problems.slice(0, 20)) console.log(`      ${p.type} ${p.id}: ${p.issue}`);
		if (problems.length > 20) console.log(`      ...and ${problems.length - 20} more (see run log)`);
	} else {
		console.log('  no discrepancies');
	}
	return { confirmed, problems, unverified };
}

_main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
