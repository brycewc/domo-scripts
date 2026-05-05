/**
 * For every user in a CSV, run the same discovery endpoints used by
 * bulk-transfer-ownership.js and emit a single CSV with one row per
 * (user, object) pair. Useful for inventorying what each user owns before a
 * cleanup, departure, or audit — the user is duplicated across however many
 * objects they own.
 *
 * Usage:
 *   node cli.js bulk-list-user-content --file users.csv
 *   node cli.js bulk-list-user-content --file users.csv --column "User ID"
 *   node cli.js bulk-list-user-content --user-id 12345
 *   node cli.js bulk-list-user-content --user-ids 12345,67890 --output owned.csv
 *   node cli.js bulk-list-user-content --file users.csv --object-types "dataset,card,dataflow"
 */

const fs = require('fs');
const path = require('path');
const api = require('../lib/api');
const { showHelp } = require('../lib/help');
const { resolveIds } = require('../lib/input');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-list-user-content [options]

For every user in --file (or --user-id/--user-ids), call all discovery endpoints
from bulk-transfer-ownership and write a CSV with one row per (user, object).

ID source (one of):
  --file <path>          CSV with user IDs (default column: "User ID")
  --user-id <id>         Single user ID
  --user-ids <a,b,c>     Comma-separated user IDs

Optional:
  --column <name>        CSV column with user IDs (default: "User ID")
  --filter-column <col>  Filter input CSV rows by column
  --filter-value <val>   Required value for --filter-column
  --object-types <csv>   Comma-separated subset of types (default: all). Same
                         aliases accepted as bulk-transfer-ownership.
  --output <path>        Output CSV path. Defaults to
                         logs/bulk-list-user-content/user_content_<ts>.csv
  --help                 Show this help

Output CSV columns: User ID, User Name, Object Type, Object ID, Object Name

Object types (case-insensitive, hyphens or underscores both accepted):
  account, ai-model, ai-project, alert, app-studio, approval, beast-mode, card,
  code-engine, collection, custom-app, dataflow, dataset, fileset, goal, group,
  jupyter, metric, page, project, project-task, publication, queue, repository,
  subscription, task, template, variable, workflow, worksheet, workspace

Notes:
  - "scheduled-report" is omitted (discovery requires a domostats dataset).
  - "publication", "custom-app", and "subscription" endpoints don't filter by
    owner server-side — those lists are fetched once and bucketed across all
    input users instead of per-user.`;

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
	for (const alias of aliases) ALIAS_TO_CANONICAL[alias] = canonical;
}
const ALL_TYPES = Object.keys(TYPE_ALIASES);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function csvField(v) {
	if (v == null) return '';
	const s = String(v);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(fields) {
	return fields.map(csvField).join(',') + '\n';
}

function normalizeType(raw) {
	if (!raw) return null;
	const k = String(raw).trim().toLowerCase().replace(/_/g, '-');
	return ALIAS_TO_CANONICAL[k] || null;
}

async function safe(label, fn) {
	try {
		return await fn();
	} catch (err) {
		console.error(`  ✗ ${label}: ${err.message || err}`);
		return null;
	}
}

async function getUserName(userId) {
	const res = await safe(`get user ${userId}`, () => api.get(`/content/v3/users/${userId}`));
	return (res && res.displayName) || `User ${userId}`;
}

// ----------------------------------------------------------------------------
// Per-user listers — return [{ id, name }, ...]
// ----------------------------------------------------------------------------

async function listAccounts(userId) {
	const out = [];
	const count = 100;
	let offset = 0;
	while (true) {
		const res = await safe(`search accounts offset=${offset}`, () =>
			api.post('/search/v1/query', {
				count,
				offset,
				combineResults: false,
				hideSearchObjects: false,
				query: '**',
				filters: [
					{
						filterType: 'term',
						field: 'owned_by_id',
						value: userId,
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
		out.push(...accounts.map((a) => ({ id: a.databaseId, name: a.name || a.displayName || '' })));
		if (accounts.length < count) break;
		offset += count;
	}
	return out;
}

async function listAiModels(userId) {
	const out = [];
	const limit = 50;
	let offset = 0;
	while (true) {
		const res = await safe(`search ai models offset=${offset}`, () =>
			api.post('/datascience/ml/v1/search/models', {
				limit,
				offset,
				sortFieldMap: { CREATED: 'DESC' },
				searchFieldMap: { NAME: '' },
				filters: [{ type: 'OWNER', values: [userId] }],
				metricFilters: {},
				dateFilters: {},
				sortMetricMap: {}
			})
		);
		if (!res || !res.models || res.models.length === 0) break;
		out.push(...res.models.map((m) => ({ id: m.id, name: m.name || '' })));
		if (res.models.length < limit) break;
		offset += limit;
	}
	return out;
}

async function listAiProjects(userId) {
	const out = [];
	const limit = 50;
	let offset = 0;
	while (true) {
		const res = await safe(`search ai projects offset=${offset}`, () =>
			api.post('/datascience/ml/v1/search/projects', {
				limit,
				offset,
				sortFieldMap: { CREATED: 'DESC' },
				searchFieldMap: { NAME: '' },
				filters: [{ type: 'OWNER', values: [userId] }],
				metricFilters: {},
				dateFilters: {},
				sortMetricMap: {}
			})
		);
		if (!res || !res.projects || res.projects.length === 0) break;
		out.push(...res.projects.map((p) => ({ id: p.id, name: p.name || '' })));
		if (res.projects.length < limit) break;
		offset += limit;
	}
	return out;
}

async function listAlerts(userId) {
	const out = [];
	const limit = 50;
	let offset = 0;
	while (true) {
		const res = await safe(`list alerts offset=${offset}`, () =>
			api.get(`/social/v4/alerts?ownerId=${userId}&limit=${limit}&offset=${offset}`)
		);
		if (!res || res.length === 0) break;
		out.push(...res.map((a) => ({ id: a.id, name: a.title || a.name || '' })));
		if (res.length < limit) break;
		offset += limit;
	}
	return out;
}

async function listAppStudioApps(userId) {
	const out = [];
	const limit = 30;
	let skip = 0;
	while (true) {
		const res = await safe(`list app studio apps skip=${skip}`, () =>
			api.post(`/content/v1/dataapps/adminsummary?limit=${limit}&skip=${skip}`, {
				ascending: true,
				includeOwnerClause: true,
				includeTitleClause: true,
				orderBy: 'title',
				ownerIds: [userId],
				titleSearchText: '',
				type: 'app'
			})
		);
		const summaries = res && res.dataAppAdminSummaries;
		if (!summaries || summaries.length === 0) break;
		out.push(...summaries.map((s) => ({ id: s.dataAppId, name: s.title || '' })));
		if (summaries.length < limit) break;
		skip += limit;
	}
	return out;
}

async function listApprovalTemplates(userId) {
	const url = '/synapse/approval/graphql';
	const res = await safe('search approval templates', () =>
		api.post(url, {
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
					ownerId: userId,
					publishedOnly: false
				}
			},
			query:
				'query getFilteredTemplates($first: Int, $after: ID, $orderBy: OrderBy, $reverseSort: Boolean, $query: TemplateQueryRequest!) { templateConnection(first: $first, after: $after, orderBy: $orderBy, reverseSort: $reverseSort, query: $query) { edges { node { id title } } } }'
		})
	);
	const edges = (res && res.data && res.data.templateConnection && res.data.templateConnection.edges) || [];
	return edges.map((e) => ({ id: e.node.id, name: e.node.title || '' }));
}

async function listApprovals(userId) {
	const url = '/synapse/approval/graphql';
	const res = await safe('search approvals', () =>
		api.post(url, {
			operationName: 'getFilteredRequests',
			variables: {
				query: {
					active: true,
					submitterId: null,
					approverId: userId,
					templateId: null,
					title: null,
					lastModifiedBefore: null
				},
				after: null,
				reverseSort: false
			},
			query:
				'query getFilteredRequests($query: QueryRequest!, $after: ID, $reverseSort: Boolean) {\n  workflowSearch(query: $query, type: "AC", after: $after, reverseSort: $reverseSort) {\n    edges {\n      node {\n        approval {\n          id\n          title\n          status\n          version\n        }\n      }\n    }\n  }\n}\n'
		})
	);
	const edges = (res && res.data && res.data.workflowSearch && res.data.workflowSearch.edges) || [];
	return edges.map((e) => ({
		id: e.node.approval.id,
		name: e.node.approval.title ? `${e.node.approval.title} (${e.node.approval.status})` : e.node.approval.status
	}));
}

async function listAppDbCollections(userId) {
	const out = [];
	const pageSize = 100;
	let pageNumber = 1;
	while (true) {
		const res = await safe(`search collections page=${pageNumber}`, () =>
			api.post('/datastores/v1/collections/query', {
				collectionFilteringList: [
					{
						filterType: 'ownedby',
						comparingCriteria: 'equals',
						typedValue: userId
					}
				],
				pageSize,
				pageNumber
			})
		);
		if (!res || !res.collections || res.collections.length === 0) break;
		out.push(...res.collections.map((c) => ({ id: c.id, name: c.name || '' })));
		if (res.collections.length < pageSize) break;
		pageNumber += 1;
	}
	return out;
}

async function listCards(userId) {
	const out = [];
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
						value: `${userId}:USER`,
						filterType: 'term'
					}
				],
				entityList: [['card']]
			})
		);
		if (!res || !res.searchObjects || res.searchObjects.length === 0) break;
		out.push(...res.searchObjects.map((c) => ({ id: c.databaseId, name: c.title || c.name || '' })));
		if (res.searchObjects.length < count) break;
		offset += count;
	}
	return out;
}

async function listCodeEnginePackages(userId) {
	const out = [];
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
						value: `${userId}:USER`
					}
				],
				hideSearchObjects: false,
				facetValuesToInclude: []
			})
		);
		const pkgs = res && res.searchResultsMap && res.searchResultsMap.package;
		if (!pkgs || pkgs.length === 0) break;
		out.push(...pkgs.map((p) => ({ id: p.uuid, name: p.name || p.title || '' })));
		if (pkgs.length < count) break;
		offset += count;
	}
	return out;
}

async function listDataflows(userId) {
	const out = [];
	const pageSize = 100;
	let offset = 0;
	while (true) {
		const res = await safe(`search dataflows offset=${offset}`, () =>
			api.post('/search/v1/query', {
				entities: ['DATAFLOW'],
				filters: [{ field: 'owned_by_id', filterType: 'term', value: userId }],
				query: '*',
				count: pageSize,
				offset
			})
		);
		if (!res || !res.searchObjects || res.searchObjects.length === 0) break;
		out.push(...res.searchObjects.map((o) => ({ id: o.databaseId, name: o.name || o.title || '' })));
		if (res.searchObjects.length < pageSize) break;
		offset += pageSize;
	}
	return out;
}

async function listDatasets(userId) {
	// /data/ui/v3/datasources/ownedBy returns IDs only; resolve names via a
	// follow-up search so the output includes them.
	const idRes = await safe('list datasets owned by user', () =>
		api.post('/data/ui/v3/datasources/ownedBy', [{ id: String(userId), type: 'USER' }])
	);
	const ids = (idRes && idRes[0] && Array.isArray(idRes[0].dataSourceIds)) ? idRes[0].dataSourceIds : [];
	if (ids.length === 0) return [];

	const nameById = {};
	const count = 100;
	let offset = 0;
	while (true) {
		const res = await safe(`search datasets offset=${offset}`, () =>
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
						value: `${userId}:USER`,
						filterType: 'term'
					}
				],
				entityList: [['dataset']]
			})
		);
		if (!res || !res.searchObjects || res.searchObjects.length === 0) break;
		for (const o of res.searchObjects) {
			if (o.databaseId != null) nameById[o.databaseId] = o.name || o.title || '';
		}
		if (res.searchObjects.length < count) break;
		offset += count;
	}
	return ids.map((id) => ({ id, name: nameById[id] || '' }));
}

async function listFilesets(userId) {
	const out = [];
	const limit = 100;
	let offset = 0;
	while (true) {
		const res = await safe(`search filesets offset=${offset}`, () =>
			api.post(`/files/v1/filesets/search?offset=${offset}&limit=${limit}`, {
				filters: [{ field: 'owner', value: [userId], not: false, operator: 'EQUALS' }],
				fieldSort: [{ field: 'updated', order: 'DESC' }],
				dateFilters: []
			})
		);
		if (!res || !res.filesets || res.filesets.length === 0) break;
		out.push(...res.filesets.map((f) => ({ id: f.id, name: f.name || '' })));
		if (res.filesets.length < limit) break;
		offset += limit;
	}
	return out;
}

async function listFunctions(userId, wantGlobal) {
	// Beast modes (global=false) and variables (global=true) share one search.
	const out = [];
	const limit = 100;
	let offset = 0;
	while (true) {
		const res = await safe(`search functions offset=${offset}`, () =>
			api.post('/query/v1/functions/search', {
				filters: [{ field: 'owner', idList: [userId] }],
				sort: { field: 'name', ascending: true },
				limit,
				offset
			})
		);
		if (!res || !res.results || res.results.length === 0) break;
		for (const t of res.results) {
			if (Boolean(t.global) === Boolean(wantGlobal)) {
				out.push({ id: t.id, name: t.name || '' });
			}
		}
		offset += limit;
		if (!res.hasMore) break;
	}
	return out;
}

async function listGoals(userId) {
	const periods = await safe('get goal periods', () => api.get('/social/v1/objectives/periods?all=true'));
	const current = (periods || []).find((p) => p.current);
	if (!current) return [];

	const data = await safe('get user goals', () =>
		api.get(
			`/social/v2/objectives/profile?filterKeyResults=false&includeSampleGoal=false&periodId=${current.id}&ownerId=${userId}`
		)
	);
	if (!data) return [];

	const seen = new Set();
	const all = [];
	const collect = (arr) => {
		if (!Array.isArray(arr)) return;
		for (const g of arr) {
			if (g.id != null && !seen.has(g.id)) {
				seen.add(g.id);
				all.push(g);
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
	return all.map((g) => ({ id: g.id, name: g.name || g.title || '' }));
}

async function listGroups(userId) {
	const out = [];
	const limit = 100;
	let offset = 0;
	while (true) {
		const res = await safe(`list groups offset=${offset}`, () =>
			api.get(`/content/v2/groups/grouplist?owner=${userId}&limit=${limit}&offset=${offset}`)
		);
		if (!res || res.length === 0) break;
		const owned = res.filter((g) => g.owners && g.owners.some((o) => o.id == userId));
		out.push(...owned.map((g) => ({ id: g.id, name: g.name || '' })));
		if (res.length < limit) break;
		offset += limit;
	}
	return out;
}

async function listJupyterWorkspaces(userId) {
	const out = [];
	const limit = 100;
	let offset = 0;
	while (true) {
		const res = await safe(`search jupyter workspaces offset=${offset}`, () =>
			api.post('/datascience/v1/search/workspaces', {
				sortFieldMap: { LAST_RUN: 'DESC' },
				searchFieldMap: {},
				filters: [{ type: 'OWNER', values: [userId] }],
				offset,
				limit
			})
		);
		if (!res || !res.workspaces || res.workspaces.length === 0) break;
		out.push(...res.workspaces.map((w) => ({ id: w.id, name: w.name || '' })));
		if (res.workspaces.length < limit) break;
		offset += limit;
	}
	return out;
}

async function listMetrics(userId) {
	const out = [];
	const limit = 100;
	let offset = 0;
	while (true) {
		const res = await safe(`list metrics offset=${offset}`, () =>
			api.post('/content/v1/metrics/filter', {
				nameContains: 'string',
				filters: { OWNER: [userId] },
				orderBy: 'CREATED',
				followed: false,
				descendingOrderBy: false,
				limit,
				offset
			})
		);
		if (!res || !res.metrics || res.metrics.length === 0) break;
		out.push(...res.metrics.map((m) => ({ id: m.id, name: m.name || m.title || '' })));
		if (res.metrics.length < limit) break;
		offset += limit;
	}
	return out;
}

async function listPages(userId) {
	const out = [];
	const limit = 50;
	let skip = 0;
	while (true) {
		const res = await safe(`list pages skip=${skip}`, () =>
			api.post(`/content/v1/pages/adminsummary?limit=${limit}&skip=${skip}`, {
				addPageWithNoOwner: false,
				includePageOwnerClause: 1,
				ownerIds: [userId],
				groupOwnerIds: [],
				orderBy: 'pageTitle',
				ascending: true
			})
		);
		const summaries = res && res.pageAdminSummaries;
		if (!summaries || summaries.length === 0) break;
		out.push(...summaries.map((p) => ({ id: p.pageId, name: p.pageTitle || p.title || '' })));
		if (summaries.length < limit) break;
		skip += limit;
	}
	return out;
}

async function getUserProjects(userId, userCache) {
	if (userCache._projects) return userCache._projects;
	const projects = [];
	const limit = 100;
	let offset = 0;
	while (true) {
		const res = await safe(`list user projects offset=${offset}`, () =>
			api.get(`/content/v2/users/${userId}/projects?limit=${limit}&offset=${offset}`)
		);
		if (!res || !Array.isArray(res.projects) || res.projects.length === 0) break;
		projects.push(...res.projects);
		if (res.projects.length < limit) break;
		offset += limit;
	}
	userCache._projects = projects;
	return projects;
}

async function listProjects(userId, userCache) {
	const projects = await getUserProjects(userId, userCache);
	return projects.map((p) => ({ id: p.id, name: p.name || p.title || '' }));
}

async function listProjectTasks(userId, userCache) {
	const projects = await getUserProjects(userId, userCache);
	const out = [];
	for (const p of projects) {
		const taskRes = await safe(`list project ${p.id} tasks`, () =>
			api.get(`/content/v1/projects/${p.id}/tasks?assignedToOwnerId=${userId}`)
		);
		if (Array.isArray(taskRes)) {
			out.push(...taskRes.map((t) => ({ id: t.id, name: t.name || t.title || '' })));
		}
	}
	return out;
}

async function listQueues(userId) {
	const out = [];
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
						value: `${userId}:USER`
					}
				]
			})
		);
		if (!res || !res.searchObjects || res.searchObjects.length === 0) break;
		out.push(...res.searchObjects.map((q) => ({ id: q.uuid, name: q.name || q.title || '' })));
		if (res.searchObjects.length < count) break;
		offset += count;
	}
	return out;
}

async function listRepositories(userId) {
	const out = [];
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
					filters: { userId: [userId] },
					dateFilters: {}
				}
			})
		);
		if (!res || !res.repositories || res.repositories.length === 0) break;
		out.push(...res.repositories.map((r) => ({ id: r.id, name: r.name || '' })));
		if (res.repositories.length < limit) break;
		offset += limit;
	}
	return out;
}

async function listTaskCenterTasks(userId) {
	const out = [];
	const limit = 100;
	let offset = 0;
	while (true) {
		const res = await safe(`list tasks offset=${offset}`, () =>
			api.post(`/queues/v1/tasks/list?limit=${limit}&offset=${offset}`, {
				assignedTo: [userId],
				status: ['OPEN']
			})
		);
		if (!res || res.length === 0) break;
		out.push(...res.map((t) => ({ id: t.id, name: t.name || t.title || '' })));
		if (res.length < limit) break;
		offset += limit;
	}
	return out;
}

async function listWorkflows(userId) {
	const out = [];
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
						value: `${userId}:USER`
					}
				]
			})
		);
		if (!res || !res.searchObjects || res.searchObjects.length === 0) break;
		out.push(...res.searchObjects.map((w) => ({ id: w.uuid, name: w.name || w.title || '' })));
		if (res.searchObjects.length < count) break;
		offset += count;
	}
	return out;
}

async function listWorksheets(userId) {
	const out = [];
	const limit = 30;
	let skip = 0;
	while (true) {
		const res = await safe(`list worksheets skip=${skip}`, () =>
			api.post(`/content/v1/dataapps/adminsummary?limit=${limit}&skip=${skip}`, {
				ascending: true,
				includeOwnerClause: true,
				includeTitleClause: true,
				orderBy: 'title',
				ownerIds: [userId],
				titleSearchText: '',
				type: 'worksheet'
			})
		);
		const summaries = res && res.dataAppAdminSummaries;
		if (!summaries || summaries.length === 0) break;
		out.push(...summaries.map((s) => ({ id: s.dataAppId, name: s.title || '' })));
		if (summaries.length < limit) break;
		skip += limit;
	}
	return out;
}

async function listWorkspaces(userId) {
	const out = [];
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
						value: userId
					}
				],
				hideSearchObjects: false,
				offset,
				query: '**',
				queryProfile: 'GLOBAL'
			})
		);
		const workspaces = res && res.searchResultsMap && res.searchResultsMap.workspace;
		if (!workspaces || workspaces.length === 0) break;
		out.push(
			...workspaces.map((w) => ({
				id: String(w.databaseId ?? w.id),
				name: w.name || w.title || ''
			}))
		);
		if (workspaces.length < count) break;
		offset += count;
	}
	return out;
}

// ----------------------------------------------------------------------------
// Global listers (server endpoint cannot filter by owner, so we pull once
// across all users and bucket).
// ----------------------------------------------------------------------------

async function listAllCustomApps() {
	const all = [];
	const limit = 100;
	let offset = 0;
	while (true) {
		const res = await safe(`list apps offset=${offset}`, () =>
			api.get(`/apps/v1/designs?checkAdminAuthority=true&deleted=false&limit=${limit}&offset=${offset}`)
		);
		if (!res || res.length === 0) break;
		all.push(...res);
		if (res.length < limit) break;
		offset += limit;
	}
	return all;
}

async function listAllPublications() {
	const all = [];
	const summaries = await safe('list publications', () => api.get('/publish/v2/publications'));
	if (!summaries || summaries.length === 0) return all;
	for (const p of summaries) {
		const detail = await safe(`get publication ${p.id}`, () => api.get(`/publish/v2/publications/${p.id}`));
		if (detail) {
			all.push({
				id: p.id,
				name: detail.name || p.name || '',
				ownerId: detail.content && detail.content.userId
			});
		}
	}
	return all;
}

async function listAllSubscriptions() {
	const all = [];
	const summaries = await safe('list subscription summaries', () => api.get('/publish/v2/subscriptions/summaries'));
	if (!summaries) return all;
	for (const summary of summaries) {
		const sub = await safe(`get subscription ${summary.subscriptionId}`, () =>
			api.get(`/publish/v2/subscriptions/${summary.subscriptionId}/share`)
		);
		if (sub && sub.subscription) {
			all.push({
				id: sub.subscription.id,
				name: sub.subscription.name || sub.subscription.publicationName || '',
				ownerId: sub.userId
			});
		}
	}
	return all;
}

function bucketCustomApps(allApps, userId) {
	return allApps
		.filter((a) => a.owner != null && String(a.owner) === String(userId))
		.map((a) => ({ id: a.id, name: a.name || a.title || '' }));
}

function bucketPublications(all, userId) {
	return all
		.filter((p) => p.ownerId != null && String(p.ownerId) === String(userId))
		.map((p) => ({ id: p.id, name: p.name }));
}

function bucketSubscriptions(all, userId) {
	return all
		.filter((s) => s.ownerId != null && String(s.ownerId) === String(userId))
		.map((s) => ({ id: s.id, name: s.name }));
}

// ----------------------------------------------------------------------------
// Dispatch
// ----------------------------------------------------------------------------

async function listForUserAndType(type, userId, caches, userCache) {
	switch (type) {
		case 'account': return listAccounts(userId);
		case 'ai-model': return listAiModels(userId);
		case 'ai-project': return listAiProjects(userId);
		case 'alert': return listAlerts(userId);
		case 'app-studio': return listAppStudioApps(userId);
		case 'approval': return listApprovals(userId);
		case 'beast-mode': return listFunctions(userId, false);
		case 'card': return listCards(userId);
		case 'code-engine': return listCodeEnginePackages(userId);
		case 'collection': return listAppDbCollections(userId);
		case 'custom-app': return bucketCustomApps(caches.customApps || [], userId);
		case 'dataflow': return listDataflows(userId);
		case 'dataset': return listDatasets(userId);
		case 'fileset': return listFilesets(userId);
		case 'goal': return listGoals(userId);
		case 'group': return listGroups(userId);
		case 'jupyter': return listJupyterWorkspaces(userId);
		case 'metric': return listMetrics(userId);
		case 'page': return listPages(userId);
		case 'project': return listProjects(userId, userCache);
		case 'project-task': return listProjectTasks(userId, userCache);
		case 'publication': return bucketPublications(caches.publications || [], userId);
		case 'queue': return listQueues(userId);
		case 'repository': return listRepositories(userId);
		case 'subscription': return bucketSubscriptions(caches.subscriptions || [], userId);
		case 'task': return listTaskCenterTasks(userId);
		case 'template': return listApprovalTemplates(userId);
		case 'variable': return listFunctions(userId, true);
		case 'workflow': return listWorkflows(userId);
		case 'worksheet': return listWorksheets(userId);
		case 'workspace': return listWorkspaces(userId);
		default: return [];
	}
}

async function _main() {
	showHelp(argv, HELP_TEXT);

	const { ids: userIds } = resolveIds(argv, { name: 'user', columnDefault: 'User ID' });

	let types = ALL_TYPES;
	if (argv['object-types']) {
		types = String(argv['object-types'])
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean)
			.map((t) => {
				const c = normalizeType(t);
				if (!c) throw new Error(`Unknown object type: "${t}"`);
				return c;
			});
	}

	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const defaultOutDir = path.join(__dirname, '..', 'logs', 'bulk-list-user-content');
	const outputFile = argv.output || path.join(defaultOutDir, `user_content_${ts}.csv`);
	fs.mkdirSync(path.dirname(outputFile), { recursive: true });
	fs.writeFileSync(outputFile, csvRow(['User ID', 'User Name', 'Object Type', 'Object ID', 'Object Name']));

	console.log('Bulk List User Content');
	console.log('======================');
	console.log(`Users:  ${userIds.length}`);
	console.log(`Types:  ${types.join(', ')}`);
	console.log(`Output: ${outputFile}`);

	// Pre-fetch caches for endpoints that don't filter by owner server-side.
	const caches = {};
	if (types.includes('custom-app')) {
		console.log('\nCaching all custom-apps (no server-side owner filter)…');
		caches.customApps = (await listAllCustomApps()) || [];
		console.log(`  cached ${caches.customApps.length} apps`);
	}
	if (types.includes('publication')) {
		console.log('Caching all publications (no server-side owner filter)…');
		caches.publications = (await listAllPublications()) || [];
		console.log(`  cached ${caches.publications.length} publications`);
	}
	if (types.includes('subscription')) {
		console.log('Caching all subscriptions (no server-side owner filter)…');
		caches.subscriptions = (await listAllSubscriptions()) || [];
		console.log(`  cached ${caches.subscriptions.length} subscriptions`);
	}

	const summary = {};
	let totalRows = 0;
	for (const userId of userIds) {
		const userName = await getUserName(userId);
		console.log(`\n=== ${userName} (${userId}) ===`);
		const userCache = {};

		for (const type of types) {
			try {
				const items = await listForUserAndType(type, userId, caches, userCache);
				console.log(`  ${type}: ${items.length}`);
				if (items.length > 0) {
					const rows = items.map((item) =>
						csvRow([userId, userName, type, item.id ?? '', item.name ?? ''])
					);
					fs.appendFileSync(outputFile, rows.join(''));
				}
				summary[type] = (summary[type] || 0) + items.length;
				totalRows += items.length;
			} catch (err) {
				console.error(`  ✗ ${type} failed: ${err.message}`);
			}
		}
		await delay(100);
	}

	console.log('\n=== Summary ===');
	for (const type of types) {
		console.log(`  ${type}: ${summary[type] || 0}`);
	}
	console.log(`\nTotal rows: ${totalRows}`);
	console.log(`CSV written to ${outputFile}`);
}

_main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
