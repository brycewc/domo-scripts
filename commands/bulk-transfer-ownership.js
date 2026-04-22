/**
 * Bulk transfer ownership of Domo content from one user to another.
 *
 * Two modes for choosing what to transfer:
 *   1) From user  — discover every object owned by --from-user and transfer it
 *   2) From file  — read specific object IDs (optionally mixed types) from a CSV
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
  --from-user <id>     Current owner's user ID (source)
  --to-user <id>       New owner's user ID (destination)

Optional:
  --file <path>        CSV file with specific IDs to transfer (instead of discovering everything)
  --id-column <name>   CSV column with object IDs (default: "Object ID")
  --type-column <name> CSV column with object type per row — needed when the CSV mixes types
  --object-types <csv> Comma-separated list of types to include. Omit to transfer every type.
                       When --file is used without --type-column, this must be exactly one type
                       and is applied to every row.
  --dry-run            Print what would be transferred without calling any write endpoints
  --help               Show this help

Object types (case-insensitive, hyphens or underscores both accepted):
  account, ai-model, ai-project, alert, app-studio, approval, beast-mode, card,
  code-engine, collection, custom-app, dataflow, dataset, fileset, goal, group,
  jupyter, metric, page, project, project-task, publication, queue, repository,
  scheduled-report, subscription, task, template, variable, workflow,
  worksheet, workspace

Notes:
  - "publication" is never actually transferred (platform limitation); it is only reported.
  - "approval" and "template" only discover from the --from-user; they ignore filtered IDs.
  - "goal" only discovers from the --from-user; it ignores filtered IDs.`;

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

// -----------------------------------------------------------------------------
// Entry point — pinned to the top by the `entry` custom group in
// eslint.config.js. Renamed from `main` to `_main` so perfectionist's sort
// keeps it above every alphabetised transfer function.
// -----------------------------------------------------------------------------

async function _main() {
	showHelp(argv, HELP_TEXT);

	const fromUserId = argv['from-user'];
	const toUserId = argv['to-user'];
	const filePath = argv.file;
	const typeColumn = argv['type-column'];
	const idColumn = argv['id-column'] || 'Object ID';
	const dryRun = Boolean(argv['dry-run']);

	if (!fromUserId) throw new Error('--from-user is required');
	if (!toUserId) throw new Error('--to-user is required');
	if (String(fromUserId) === String(toUserId)) {
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

	// Build filtered-ID map from CSV when --file is provided.
	let objectsByType = null;
	if (filePath) {
		const records = readCSV(filePath);
		if (records.length === 0) throw new Error('CSV file has no rows');
		const columns = Object.keys(records[0]);
		if (!columns.includes(idColumn)) {
			throw new Error(`ID column "${idColumn}" not found in CSV. Available: ${columns.join(', ')}`);
		}
		if (!typeColumn) {
			if (!requestedTypes || requestedTypes.length !== 1) {
				throw new Error('With --file and no --type-column, --object-types must specify exactly one type.');
			}
		} else if (!columns.includes(typeColumn)) {
			throw new Error(`Type column "${typeColumn}" not found in CSV. Available: ${columns.join(', ')}`);
		}

		objectsByType = {};
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
			if (!objectsByType[canon]) objectsByType[canon] = [];
			objectsByType[canon].push(id);
		}
	}

	const [fromUserName, toUserName] = await Promise.all([getUserName(fromUserId), getUserName(toUserId)]);

	const typesToProcess = objectsByType ? Object.keys(objectsByType) : requestedTypes || ALL_TYPES;

	const logger = createLogger('bulk-transfer-ownership', {
		debugMode: false,
		dryRun,
		runMeta: {
			fromUserId: fromUserId,
			fromUserName: fromUserName,
			toUserId: toUserId,
			toUserName: toUserName,
			mode: objectsByType ? 'file' : 'user',
			file: filePath || null,
			requestedTypes: requestedTypes || 'all'
		}
	});

	console.log('Bulk Transfer Ownership');
	console.log('========================');
	console.log(`From:      ${fromUserName} (${fromUserId})`);
	console.log(`To:        ${toUserName} (${toUserId})`);
	console.log(`Mode:      ${objectsByType ? `file (${filePath})` : 'user discovery'}`);
	console.log(`Types:     ${typesToProcess.join(', ')}`);
	if (dryRun) console.log('DRY RUN — no write calls will be made.');

	const ctx = { fromUserId, toUserId, fromUserName, toUserName, dryRun };
	const summary = { totals: {}, skipped: [] };

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

		try {
			const res = await runType(type, filtered, ctx);
			const transferred = (res && res.transferred) || [];
			summary.totals[type] = transferred.length;
			logger.addResult({ type, transferred, details: res });
			console.log(`  → ${transferred.length} transferred`);
		} catch (err) {
			console.error(`  ✗ ${type} failed: ${err.message}`);
			summary.totals[type] = 0;
			logger.addResult({ type, error: err.message });
		}
	}

	// Beast modes + variables share transferFunctions — call it once.
	const beastSelected = typesToProcess.includes('beast-mode');
	const varSelected = typesToProcess.includes('variable');
	if (beastSelected || varSelected) {
		console.log(`\n=== beast-mode / variable ===`);
		const combinedIds = [
			...((objectsByType && objectsByType['beast-mode']) || []),
			...((objectsByType && objectsByType['variable']) || [])
		];
		try {
			const res = await transferFunctions(fromUserId, toUserId, combinedIds, ctx);
			if (beastSelected) {
				summary.totals['beast-mode'] = (res.beastModes || []).length;
				logger.addResult({
					type: 'beast-mode',
					transferred: res.beastModes,
					details: { deleted: res.deletedBeastModes }
				});
				console.log(`  → ${(res.beastModes || []).length} beast modes transferred`);
			}
			if (varSelected) {
				summary.totals['variable'] = (res.variables || []).length;
				logger.addResult({
					type: 'variable',
					transferred: res.variables,
					details: { deleted: res.deletedVariables }
				});
				console.log(`  → ${(res.variables || []).length} variables transferred`);
			}
		} catch (err) {
			console.error(`  ✗ beast-mode/variable failed: ${err.message}`);
		}
	}

	// Projects + project-tasks share a single API flow; handle them together.
	const projectsSelected = typesToProcess.includes('project');
	const taskSelected = typesToProcess.includes('project-task');
	if (projectsSelected || taskSelected) {
		console.log(`\n=== project / project-task ===`);
		const projectIds = (objectsByType && objectsByType['project']) || [];
		const taskIds = (objectsByType && objectsByType['project-task']) || [];
		try {
			const res = await transferProjectsAndTasks(fromUserId, toUserId, projectIds, taskIds, ctx);
			if (projectsSelected) {
				summary.totals['project'] = (res.projects || []).length;
				logger.addResult({ type: 'project', transferred: res.projects, details: res });
				console.log(`  → ${(res.projects || []).length} projects transferred`);
			}
			if (taskSelected) {
				summary.totals['project-task'] = (res.tasks || []).length;
				logger.addResult({ type: 'project-task', transferred: res.tasks, details: res });
				console.log(`  → ${(res.tasks || []).length} tasks transferred`);
			}
		} catch (err) {
			console.error(`  ✗ projects/tasks failed: ${err.message}`);
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
	logger.writeRunLog(summary);
}

// -----------------------------------------------------------------------------
// Every other function below — alphabetical by name. Enforced by
// `perfectionist/sort-modules` in eslint.config.js.
// -----------------------------------------------------------------------------

async function getUserName(fromUserId) {
	const res = await safe(`get user ${fromUserId}`, () => api.get(`/content/v3/users/${fromUserId}`));
	return (res && res.displayName) || `User ${fromUserId}`;
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
	const { fromUserId, toUserId } = ctx;
	const handler = HANDLERS[type];
	if (!handler) {
		console.warn(`Unknown type: ${type}`);
		return { transferred: [] };
	}
	return handler(fromUserId, toUserId, ids, ctx);
}

async function safe(label, fn) {
	try {
		return await fn();
	} catch (err) {
		console.error(`  ✗ ${label}: ${err.message || err}`);
		return null;
	}
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

	for (const id of ids) {
		await safe(`reassign account ${id}`, () =>
			api.put(`/data/v2/accounts/share/${id}`, {
				type: 'USER',
				id: toUserId,
				accessLevel: 'OWNER'
			})
		);
	}
	return { transferred: ids };
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

	for (const id of ids) {
		await safe(`reassign ai model ${id}`, () =>
			api.post(`/datascience/ml/v1/models/${id}/ownership`, { userId: toUserId })
		);
	}
	return { transferred: ids };
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

	for (const id of ids) {
		await safe(`reassign ai project ${id}`, () =>
			api.post(`/datascience/ml/v1/projects/${id}/ownership`, { userId: toUserId })
		);
	}
	return { transferred: ids };
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

	for (const id of ids) {
		await safe(`update alert ${id}`, () => api.request('PATCH', `/social/v4/alerts/${id}`, { id, owner: toUserId }));
	}
	return { transferred: ids };
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

	for (const id of ids) {
		await safe(`update collection ${id}`, () => api.put(`/datastores/v1/collections/${id}`, { id, owner: toUserId }));
	}
	return { transferred: ids };
}

async function transferAppStudioApps(fromUserId, toUserId, filteredIds, { dryRun }) {
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

	await safe('add app studio owners', () =>
		api.put('/content/v1/dataapps/bulk/owners', {
			note: '',
			entityIds: ids,
			owners: [{ type: 'USER', id: parseInt(toUserId, 10) }],
			sendEmail: false
		})
	);
	await safe('remove old app studio owners', () =>
		api.post('/content/v1/dataapps/bulk/owners/remove', {
			entityIds: ids,
			owners: [{ type: 'USER', id: fromUserId }]
		})
	);
	return { transferred: ids };
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

async function transferCards(fromUserId, toUserId, filteredIds, { dryRun }) {
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

	await safe('add card owner', () =>
		api.post('/content/v1/cards/owners/add', {
			cardIds: ids,
			cardOwners: [{ id: toUserId, type: 'USER' }],
			note: '',
			sendEmail: false
		})
	);
	return { transferred: ids };
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

	for (const id of ids) {
		await safe(`reassign package ${id}`, () =>
			api.put(`/codeengine/v2/packages/${id}`, {
				owner: parseInt(toUserId, 10)
			})
		);
	}
	return { transferred: ids };
}

async function transferCustomApps(fromUserId, toUserId, filteredIds, { dryRun }) {
	const bricks = [];
	const proCodeApps = [];
	const ownedByUser = [];

	const classify = (appSummary) => {
		if (appSummary.owner != fromUserId) return;
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

	for (const id of ownedByUser) {
		await safe(`grant admin to new owner on app ${id}`, () =>
			api.post(`/apps/v1/designs/${id}/permissions/ADMIN`, [toUserId])
		);
	}
	return { transferred: ownedByUser, bricks, proCodeApps };
}

async function transferDataflows(fromUserId, toUserId, filteredIds, { dryRun, fromUserName }) {
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
	if (dryRun) return { transferred: ids };

	await safe('reassign dataflows', () =>
		api.put('/dataprocessing/v1/dataflows/bulk/patch', {
			dataFlowIds: ids,
			responsibleUserId: toUserId
		})
	);

	const batchSize = 50;
	for (let i = 0; i < ids.length; i += batchSize) {
		const chunk = ids.slice(i, i + batchSize);
		await safe(`tag dataflows ${i + 1}-${i + chunk.length}`, () =>
			api.put('/dataprocessing/v1/dataflows/bulk/tag', {
				dataFlowIds: chunk,
				tagNames: [`From ${fromUserName}`]
			})
		);
	}
	return { transferred: ids };
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

	if (dryRun) return { transferred: ids };

	const batchSize = 50;
	for (let i = 0; i < ids.length; i += batchSize) {
		const chunk = ids.slice(i, i + batchSize);
		await safe(`reassign datasets ${i + 1}-${i + chunk.length}`, () =>
			api.post('/data/v1/ui/bulk/reassign', {
				type: 'DATA_SOURCE',
				ids: chunk,
				userId: toUserId
			})
		);
		await safe(`tag datasets ${i + 1}-${i + chunk.length}`, () =>
			api.post('/data/v1/ui/bulk/tag', {
				bulkItems: { ids: chunk, type: 'DATA_SOURCE' },
				tags: [`From ${fromUserName}`]
			})
		);
	}
	return { transferred: ids };
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

	for (const id of ids) {
		await safe(`reassign fileset ${id}`, () =>
			api.post(`/files/v1/filesets/${id}/ownership`, {
				userId: parseInt(toUserId, 10)
			})
		);
	}
	return { transferred: ids };
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
				await safe(`bulk update ${bucket} ${i + 1}-${i + chunk.length}`, () => api.post(bulkUrl, { update: chunk }));
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
						await safe(`bulk update ${bucket} ${i + 1}-${i + chunk.length}`, () =>
							api.post(bulkUrl, { update: chunk })
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

	for (const goal of allGoals) {
		goal.ownerId = toUserId;
		goal.owners = [{ ownerId: toUserId, ownerType: 'USER', primary: false }];
		await safe(`update goal ${goal.id}`, () => api.put(`/social/v1/objectives/${goal.id}`, goal));
	}
	return { transferred: allGoals.map((g) => g.id) };
}

async function transferGroups(fromUserId, toUserId, filteredIds, { dryRun }) {
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

	await safe('update group owners', () =>
		api.put(
			'/content/v2/groups/access',
			ids.map((gid) => ({
				groupId: gid,
				addOwners: [{ type: 'USER', id: toUserId }],
				removeOwners: [{ type: 'USER', id: fromUserId }]
			}))
		)
	);
	return { transferred: ids };
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

	for (const id of ids) {
		await safe(`reassign workspace ${id}`, () =>
			api.put(`/datascience/v1/workspaces/${id}/ownership`, { newOwnerId: toUserId })
		);
	}
	return { transferred: ids };
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

async function transferPages(fromUserId, toUserId, filteredIds, { dryRun }) {
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

	await safe('add page owners', () =>
		api.put('/content/v1/pages/bulk/owners', {
			owners: [{ id: toUserId, type: 'USER' }],
			pageIds: ids
		})
	);
	await safe('remove old page owners', () =>
		api.post('/content/v1/pages/bulk/owners/remove', {
			owners: [{ id: parseInt(fromUserId, 10), type: 'USER' }],
			pageIds: ids
		})
	);
	return { transferred: ids };
}

async function transferProjectsAndTasks(fromUserId, toUserId, filteredProjectIds, filteredTaskIds, { dryRun }) {
	const projects = [];
	const tasks = [];

	if (filteredProjectIds.length > 0 || filteredTaskIds.length > 0) {
		for (const id of filteredProjectIds) {
			const project = await safe(`get project ${id}`, () => api.get(`/content/v1/projects/${id}`));
			if (project && project.assignedTo == fromUserId) projects.push(project);
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

	if (dryRun) {
		return {
			transferred: [...projects.filter((p) => p.assignedTo == fromUserId).map((p) => p.id), ...tasks.map((t) => t.id)],
			projects: projects.filter((p) => p.assignedTo == fromUserId).map((p) => p.id),
			tasks: tasks.map((t) => t.id)
		};
	}

	const transferredTaskIds = [];
	for (const task of tasks) {
		transferredTaskIds.push(task.id);
		if (task.primaryTaskOwner == fromUserId) task.primaryTaskOwner = toUserId;
		task.contributors = task.contributors || [];
		task.owners = task.owners || [];
		task.contributors.push({ assignedTo: toUserId, assignedBy: fromUserId });
		task.owners.push({ assignedTo: toUserId, assignedBy: fromUserId });
		await safe(`update task ${task.id}`, () => api.put(`/content/v1/tasks/${task.id}`, task));
	}

	const transferredProjectIds = [];
	for (const project of projects) {
		if (project.assignedTo == fromUserId) {
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

async function transferRepositories(fromUserId, toUserId, filteredIds, { dryRun }) {
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

	for (const id of ids) {
		await safe(`reassign repository ${id}`, () =>
			api.post(`/version/v1/repositories/${id}/permissions`, {
				repositoryPermissionUpdates: [
					{ userId: toUserId, permission: 'OWNER' },
					{ userId: fromUserId, permission: 'NONE' }
				]
			})
		);
	}
	return { transferred: ids };
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

	for (const id of ids) {
		const report = await safe(`get report ${id}`, () => api.get(`/content/v1/reportschedules/${id}`));
		if (!report) continue;
		await safe(`update report ${id}`, () =>
			api.put(`/content/v1/reportschedules/${id}`, {
				id: report.id,
				ownerId: toUserId,
				schedule: report.schedule,
				subject: report.subject,
				viewId: report.viewId
			})
		);
	}
	return { transferred: ids };
}

async function transferSubscriptions(fromUserId, toUserId, filteredIds, { dryRun }) {
	const toTransfer = [];
	if (filteredIds.length > 0) {
		for (const subId of filteredIds) {
			const sub = await safe(`get subscription ${subId}`, () => api.get(`/publish/v2/subscriptions/${subId}/share`));
			if (sub && sub.userId == fromUserId) toTransfer.push(sub);
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

	for (const id of ids) {
		await safe(`set queue ${id} owner`, () => api.put(`/queues/v1/${id}/owner/${toUserId}`));
	}
	return { transferred: ids };
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

	for (const id of ids) {
		const workflow = await safe(`get workflow ${id}`, () => api.get(`/workflow/v1/models/${id}`));
		if (!workflow) continue;
		workflow.owner = String(toUserId);
		await safe(`update workflow ${id}`, () => api.put(`/workflow/v1/models/${id}`, workflow));
	}
	return { transferred: ids };
}

// Worksheets live on the same DATA_APP backend as App Studio apps and share
// the /dataapps/bulk/owners endpoints; the adminsummary `type` filter is what
// separates them.
async function transferWorksheets(fromUserId, toUserId, filteredIds, { dryRun }) {
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

	await safe('add worksheet owners', () =>
		api.put('/content/v1/dataapps/bulk/owners', {
			note: '',
			entityIds: ids,
			owners: [{ type: 'USER', id: parseInt(toUserId, 10) }],
			sendEmail: false
		})
	);
	await safe('remove old worksheet owners', () =>
		api.post('/content/v1/dataapps/bulk/owners/remove', {
			entityIds: ids,
			owners: [{ type: 'USER', id: fromUserId }]
		})
	);
	return { transferred: ids };
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
async function transferWorkspaces(fromUserId, toUserId, filteredIds, { dryRun }) {
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
			const sourceMember = members.find((m) => m.memberType === 'USER' && m.memberId === fromUserId);

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

			if (sourceMember) {
				try {
					await api.del(`/nav/v1/workspaces/${id}/members/${sourceMember.id}`);
				} catch (delErr) {
					console.warn(
						`  ⚠ workspace ${id}: promoted new OWNER but failed to remove previous owner — workspace may now have two owners (${delErr.message})`
					);
				}
			}
			transferred.push(id);
		} catch (err) {
			console.error(`  ✗ workspace ${id}: ${err.message}`);
		}
	}
	return { transferred };
}

_main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
