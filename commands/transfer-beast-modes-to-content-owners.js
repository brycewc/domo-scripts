/**
 * Transfer a user's beast modes to the owners of the cards and datasets they live on.
 *
 * Every beast mode belongs to either a dataset or a single card. This finds each
 * one owned by --from-user, works out which it is, resolves that card's or
 * dataset's owner, and hands the beast mode to them.
 *
 * A beast mode cannot be owned by a group, so a group-owned card or dataset falls
 * through a cascade instead:
 *   1. the owner of the dataflow that writes the dataset, when it is an output
 *   2. the departing user's manager, if they are an active member of that group
 *   3. otherwise the active member who owns the most beast modes, ties broken in
 *      favour of the older account
 *
 * Variables (global functions) have no card or dataset scope to route on and are
 * never touched.
 *
 * Usage:
 *   node cli.js transfer-beast-modes-to-content-owners --from-user 12345 --dry-run
 *   node cli.js transfer-beast-modes-to-content-owners --from-user 12345 --output plan.csv --dry-run
 *   node cli.js transfer-beast-modes-to-content-owners --from-user 12345 --verify --yes
 *   node cli.js transfer-beast-modes-to-content-owners --from-user 12345 --manager 67890
 *
 * Options:
 *   --from-user, -u      User ID whose beast modes are transferred (required)
 *   --manager <id>       Manager user ID, overriding the "reports to" lookup
 *   --dataflow-map-dataset <id>  Governance dataset holding the output-dataset to
 *                        dataflow edge, when it cannot be resolved by name
 *   --output, -o         Write the full routing plan to this CSV
 *   --max, -m            Stop after this many beast modes
 *   --batch-size, -b     Beast modes per bulk update call (default: 50)
 *   --allow-inactive-owner  Route to a card/dataset owner even when deactivated
 *   --verify             Re-read every transferred beast mode and confirm the owner moved
 *   --yes, -y            Skip the confirmation prompt
 *   --dry-run            Print the routing plan without transferring anything
 */

const { api, config, createLogger, showHelp } = require('../lib');
const fs = require('fs');
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

const PAGE_SIZE = 100;
const CARD_BATCH = 100;
const SQL_BATCH = 200;
const DATAFLOW_MAP_NAME = 'GOLD | MajorDomo | DataFlows by Output DataSet';
const PREVIEW_LIMIT = 40;
const CALL_DELAY = 100;
const BATCH_DELAY = 150;
const MAX_PASSES = 5;

const HELP_TEXT = `Usage: node cli.js transfer-beast-modes-to-content-owners --from-user <id> [options]

Transfers each beast mode owned by --from-user to whoever owns the card or dataset
it lives on. A beast mode's scope is the link Domo marks visible: a DATA_SOURCE
link means it belongs to that dataset, a CARD link means it belongs to that card.

Because a beast mode cannot be owned by a group, a group-owned card or dataset
falls through a cascade instead:
  1. the owner of the dataflow that writes the dataset, when the dataset is a
     dataflow output. A dataflow cannot be group-owned either, so this always
     lands on a real user.
  2. the departing user's manager, if they are an active member of that group
  3. otherwise the active member owning the most beast modes, ties broken in
     favour of the older account

Variables are never routed or transferred: they have no card or dataset scope.

Required:
  --from-user, -u <id>    User ID whose beast modes are transferred

Optional:
  --manager <id>          Manager user ID to use for rule 2, overriding the "reports to"
                          attribute. That attribute is usually blank on terminated and
                          integration accounts, which is exactly when this is needed.
  --dataflow-map-dataset <id>
                          Dataset id of "GOLD | MajorDomo | DataFlows by Output DataSet",
                          which carries the only clean dataset-to-producing-dataflow edge.
                          Resolved by name automatically; pass this when the instance
                          names it differently. Without it rule 1 is skipped.
  --output, -o <path>     Write the full routing plan (one row per beast mode, with the
                          resource, its owners, the destination and the rule) to a CSV
  --max, -m <n>           Stop after this many beast modes
  --batch-size, -b <n>    Beast modes per bulk update call (default: 50). A failed batch
                          is retried one beast mode at a time.
  --allow-inactive-owner  Route to the card/dataset owner even when that account is
                          deactivated. Off by default, so those are reported instead.
  --verify                After transferring, re-read every beast mode and confirm the
                          owner actually moved. Skipped on a dry run.
  --yes, -y               Skip the confirmation prompt
  --dry-run               Print the routing plan without transferring anything
  --help                  Show this help`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const errors = [];

async function safe(label, fn) {
	try {
		return await fn();
	} catch (err) {
		errors.push({ label, error: err.message });
		console.error(`  ✗ ${label}: ${err.message}`);
		return null;
	}
}

function ask(question) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) =>
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase());
		})
	);
}

function csvField(v) {
	if (v == null) return '';
	const s = String(v);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(fields) {
	return fields.map(csvField).join(',') + '\n';
}

// Domo reports `created` in seconds on user payloads and milliseconds elsewhere,
// so normalize before comparing two accounts' ages.
function createdMs(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return null;
	return n < 1e11 ? n * 1000 : n;
}

// A deactivated account keeps a mangled address (name@domo.com_deleted_1759772994949)
// and sometimes still reports active: true, so both signals are needed.
function isEligibleUser(user) {
	if (!user || user.id == null) return false;
	if (user.active === false) return false;
	if (user.systemUser || user.anonymous) return false;
	return !String(user.emailAddress || user.userName || '').includes('_deleted_');
}

// A card link can point at a drill view, whose urn is dr:<drillViewId>:<cardId>.
// Drill views are always ownerless; the owner sits on the parent card named by the
// last segment, so route on that rather than reporting the formula as unroutable.
function cardTarget(urn) {
	const value = String(urn);
	if (!value.startsWith('dr:')) return { id: value, drillOf: null };
	const segments = value.split(':').filter((s) => /^\d+$/.test(s));
	if (segments.length === 0) return { id: value, drillOf: null };
	return { id: segments[segments.length - 1], drillOf: value };
}

// The visible link is the beast mode's home: a dataset beast mode carries a visible
// DATA_SOURCE link, a card beast mode a visible CARD link. Every other link is just
// a card that happens to use the formula.
function classify(template) {
	const links = template.links || [];
	const ofType = (type) => links.filter((l) => l.resource && l.resource.type === type);
	const datasets = ofType('DATA_SOURCE');
	const cards = ofType('CARD');
	const card = (link, inferred) => ({ scope: 'card', ...cardTarget(link.resource.id), inferred });

	const visibleDataset = datasets.find((l) => l.visible);
	if (visibleDataset) return { scope: 'dataset', id: String(visibleDataset.resource.id), drillOf: null };
	const visibleCard = cards.find((l) => l.visible);
	if (visibleCard) return card(visibleCard, false);

	if (datasets.length === 1) {
		return { scope: 'dataset', id: String(datasets[0].resource.id), drillOf: null, inferred: true };
	}
	if (cards.length === 1) return card(cards[0], true);
	return { scope: null, id: null, drillOf: null };
}

const cardCache = new Map();
const datasetCache = new Map();
const groupCache = new Map();
const userCache = new Map();
const beastModeCounts = new Map();
const destinationCache = new Map();
const dataflowOwnerCache = new Map();

// The governance dataset's id differs per instance, so resolve it by exact name and
// let --dataflow-map-dataset pin it. Returning null just disables the producing
// dataflow rule; the rest of the cascade still works.
async function resolveDataflowMapDataset(override) {
	if (override) return String(override);
	const res = await safe(`find "${DATAFLOW_MAP_NAME}"`, () =>
		api.post('/search/v1/query', {
			count: 20,
			offset: 0,
			combineResults: false,
			hideSearchObjects: false,
			query: DATAFLOW_MAP_NAME,
			filters: [],
			facetValuesToInclude: [],
			queryProfile: 'GLOBAL',
			entityList: [['dataset']]
		})
	);
	const rows = (res && res.searchResultsMap && res.searchResultsMap.dataset) || [];
	const match = rows.find((d) => d.name === DATAFLOW_MAP_NAME);
	return match ? String(match.databaseId || match.entityId) : null;
}

// Map each output dataset to the dataflow that writes it. This governance dataset is
// the only clean dataset-to-producing-dataflow edge: GET /data/v1/lineage/DATA_SOURCE/{id}
// with traverseDown=false returns the entire upstream tree rather than the immediate
// parent, and the dataset's own transportType only says that it is an output.
async function loadDataflowOwners(datasetIds, mapDatasetId) {
	const missing = datasetIds.filter((id) => !dataflowOwnerCache.has(id));
	for (const id of missing) dataflowOwnerCache.set(id, null);
	if (missing.length === 0 || !mapDatasetId) return;

	for (let i = 0; i < missing.length; i += SQL_BATCH) {
		const chunk = missing.slice(i, i + SQL_BATCH);
		const list = chunk.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(', ');
		const sql =
			'SELECT `Output DataSet ID`, `DataFlow ID`, `DataFlow Name`, `DataFlow Owner ID`, ' +
			'`DataFlow Owner Name`, `DataFlow Owner Type`, `DataFlow Owner Active` ' +
			`FROM table WHERE \`Output DataSet ID\` IN (${list})`;
		const res = await safe(`resolve producing dataflows ${i + 1}-${i + chunk.length}`, () =>
			api.post(`/query/v1/execute/${mapDatasetId}`, { sql })
		);
		const columns = (res && res.columns) || [];
		const at = (row, column) => {
			const index = columns.indexOf(column);
			return index === -1 ? null : row[index];
		};
		for (const row of (res && res.rows) || []) {
			const datasetId = String(at(row, 'Output DataSet ID') || '');
			const ownerId = at(row, 'DataFlow Owner ID');
			if (!datasetId || !ownerId || dataflowOwnerCache.get(datasetId)) continue;
			// A dataflow cannot be group-owned, so a non-user owner is a stale row.
			if (String(at(row, 'DataFlow Owner Type')).toUpperCase() !== 'USER') continue;
			if (String(at(row, 'DataFlow Owner Active')).toUpperCase() !== 'YES') continue;
			dataflowOwnerCache.set(datasetId, {
				dataflowId: at(row, 'DataFlow ID'),
				dataflowName: at(row, 'DataFlow Name'),
				ownerId: String(ownerId),
				ownerName: at(row, 'DataFlow Owner Name')
			});
		}
		await delay(BATCH_DELAY);
	}
}

// The owner search sorted by name is not stable: beast-mode names repeat heavily, so
// rows with equal keys reorder between pages and plain offset paging both duplicates
// and misses ids. Dedupe by id while paging, and let the caller repeat the whole pass.
async function findBeastModes(ownerId) {
	const found = new Map();
	for (let offset = 0; ; offset += PAGE_SIZE) {
		const res = await safe(`search beast modes offset=${offset}`, () =>
			api.post('/query/v1/functions/search', {
				filters: [{ field: 'owner', idList: [String(ownerId)] }, { field: 'notvariable' }],
				sort: { field: 'name', ascending: true },
				limit: PAGE_SIZE,
				offset
			})
		);
		const rows = (res && res.results) || [];
		for (const t of rows) if (!found.has(String(t.id))) found.set(String(t.id), t);
		if (rows.length === 0 || !res || !res.hasMore) break;
		await delay(BATCH_DELAY);
	}
	return [...found.values()];
}

async function getUser(id) {
	const key = String(id);
	if (userCache.has(key)) return userCache.get(key);
	const user = await safe(`get user ${key}`, () => api.get(`/content/v2/users/${key}`));
	userCache.set(key, user || null);
	return user || null;
}

function userLabel(id) {
	const user = userCache.get(String(id));
	return user && user.displayName ? `${user.displayName} (${id})` : String(id);
}

// Cards have no per-id endpoint, so they are read in batches off the urns list. A
// card missing from the response no longer exists; cache the null so the same dead
// id is not requested again on a later pass.
async function loadCards(ids) {
	const missing = [...new Set(ids.map(String))].filter((id) => !cardCache.has(id));
	for (let i = 0; i < missing.length; i += CARD_BATCH) {
		const chunk = missing.slice(i, i + CARD_BATCH);
		const res = await safe(`get card owners ${i + 1}-${i + chunk.length}`, () =>
			api.get(`/content/v1/cards?urns=${chunk.join(',')}&parts=owners`)
		);
		const rows = Array.isArray(res) ? res : (res && res.cards) || [];
		const byId = new Map(rows.map((c) => [String(c.urn != null ? c.urn : c.id), c]));
		for (const id of chunk) {
			const card = byId.get(id);
			cardCache.set(id, card ? { name: card.title, owners: card.owners || [] } : null);
		}
		await delay(BATCH_DELAY);
	}
}

async function getDataset(id) {
	const key = String(id);
	if (datasetCache.has(key)) return datasetCache.get(key);
	const ds = await safe(`get dataset ${key}`, () => api.get(`/data/v3/datasources/${key}?includeAllDetails=false`));
	if (!ds) {
		datasetCache.set(key, null);
		return null;
	}
	const owner = ds.owner;
	const owners =
		owner && owner.id != null
			? [{ id: String(owner.id), type: owner.type || (owner.group === true ? 'GROUP' : 'USER'), displayName: owner.name }]
			: [];
	datasetCache.set(key, { name: ds.name, owners });
	await delay(CALL_DELAY);
	return datasetCache.get(key);
}

async function getGroup(id) {
	const key = String(id);
	if (groupCache.has(key)) return groupCache.get(key);
	const res = await safe(`get group ${key} members`, () =>
		api.post('/content/v2/groups/get?includeActive=true&includeUsers=true', [key])
	);
	const group = Array.isArray(res) ? res[0] : null;
	const users = group ? group.users || [] : [];
	for (const user of users) {
		if (user && user.id != null && !userCache.has(String(user.id))) userCache.set(String(user.id), user);
	}
	groupCache.set(key, { name: group ? group.name : null, users });
	await delay(CALL_DELAY);
	return groupCache.get(key);
}

// totalHits is a search-index count, so it can drift by a handful against a fully
// deduped enumeration. That is close enough to rank candidates and costs one call
// each instead of paging every candidate's whole library.
async function countBeastModes(userId) {
	const key = String(userId);
	if (beastModeCounts.has(key)) return beastModeCounts.get(key);
	const res = await safe(`count beast modes owned by ${key}`, () =>
		api.post('/query/v1/functions/search', {
			filters: [{ field: 'owner', idList: [key] }, { field: 'notvariable' }],
			sort: { field: 'name', ascending: true },
			limit: 1,
			offset: 0
		})
	);
	const count = res && typeof res.totalHits === 'number' ? res.totalHits : 0;
	beastModeCounts.set(key, count);
	await delay(CALL_DELAY);
	return count;
}

// Most beast modes wins; ties go to the older account, then to the lower id so two
// runs over the same group always land on the same person.
async function rankCandidates(users) {
	const scored = [];
	for (const user of users) {
		const created = createdMs(user.created);
		scored.push({
			user,
			count: await countBeastModes(user.id),
			created: created == null ? Number.MAX_SAFE_INTEGER : created
		});
	}
	scored.sort((a, b) => b.count - a.count || a.created - b.created || Number(a.user.id) - Number(b.user.id));
	return scored;
}

async function getManagerId(userId) {
	const res = await safe(`get manager for ${userId}`, () =>
		api.post('/identity/v1/users/search', {
			attributes: ['id', 'displayName', 'reportsTo'],
			ids: [Number(userId)],
			includeDeleted: true,
			limit: 1,
			offset: 0,
			parts: ['DETAILED']
		})
	);
	const user = res && res.users && res.users[0];
	if (!user) return null;
	const attribute = (user.attributes || []).find((a) => a.key === 'reportsTo');
	const value = attribute && attribute.values && attribute.values[0];
	return value ? String(value) : null;
}

async function resolveGroupDestination(group, resource, ctx) {
	const { name, users } = await getGroup(group.id);
	const label = name || group.displayName || group.id;

	// A dataflow cannot be group-owned either, so when the dataset is a dataflow
	// output its producing dataflow's owner always lands on a real user and is the
	// closest thing to an actual owner the group can offer.
	if (resource && resource.scope === 'dataset') {
		const producer = dataflowOwnerCache.get(resource.id);
		if (producer && producer.ownerId !== ctx.fromUserId && isEligibleUser(await getUser(producer.ownerId))) {
			return {
				userId: producer.ownerId,
				rule: 'producing-dataflow-owner',
				note: `group "${label}", dataflow ${producer.dataflowId} "${producer.dataflowName}"`
			};
		}
	}

	const eligible = users.filter(isEligibleUser).filter((u) => String(u.id) !== ctx.fromUserId);

	if (ctx.managerId && eligible.some((u) => String(u.id) === ctx.managerId)) {
		return { userId: ctx.managerId, rule: 'manager-in-group', note: `group "${label}"` };
	}
	if (eligible.length === 0) {
		return { userId: null, rule: 'group-has-no-eligible-members', note: `group "${label}"` };
	}
	const [top] = await rankCandidates(eligible);
	return {
		userId: String(top.user.id),
		rule: 'top-beast-mode-owner-in-group',
		note: `group "${label}", ${top.count} beast mode(s)${ctx.managerId ? '' : ', no manager on record'}`
	};
}

async function resolveDestination(owners, resource, ctx) {
	if (owners === null) return { userId: null, rule: 'resource-not-found' };
	if (owners.length === 0) return { userId: null, rule: 'resource-ownerless' };

	const userOwners = owners.filter((o) => (o.type || 'USER') !== 'GROUP');
	const groupOwners = owners.filter((o) => o.type === 'GROUP');

	if (userOwners.length > 0) {
		const resolved = [];
		for (const owner of userOwners) {
			const user = await getUser(owner.id);
			if (user) resolved.push(user);
		}
		const active = resolved.filter(isEligibleUser);
		const pool = active.length > 0 ? active : ctx.allowInactiveOwner ? resolved : [];
		if (pool.length === 1) {
			return { userId: String(pool[0].id), rule: active.length > 0 ? 'content-owner' : 'content-owner-inactive' };
		}
		if (pool.length > 1) {
			const [top] = await rankCandidates(pool);
			return {
				userId: String(top.user.id),
				rule: active.length > 0 ? 'content-owner-ranked' : 'content-owner-inactive-ranked',
				note: `${pool.length} user owners, ${top.count} beast mode(s)`
			};
		}
		if (groupOwners.length === 0) return { userId: null, rule: 'content-owner-inactive' };
	}

	let lastFailure = null;
	for (const group of groupOwners) {
		const result = await resolveGroupDestination(group, resource, ctx);
		if (result.userId) return result;
		lastFailure = result;
	}
	return lastFailure || { userId: null, rule: 'resource-ownerless' };
}

// Resource owners are shared by many beast modes, so the whole routing decision is
// cached per resource rather than per beast mode.
async function routeBeastMode(template, ctx) {
	const { scope, id: resourceId, drillOf, inferred } = classify(template);
	const notes = [];
	if (inferred) notes.push('scope inferred: no visible link');
	if (drillOf) notes.push(`scoped to drill view ${drillOf}`);
	const plan = {
		id: String(template.id),
		name: template.name,
		scope,
		resourceId,
		resourceName: null,
		owners: [],
		destination: null,
		rule: null,
		note: null,
		status: null
	};

	if (!scope) {
		plan.rule = 'no-card-or-dataset-link';
		return plan;
	}

	const cacheKey = `${scope}:${resourceId}`;
	if (!destinationCache.has(cacheKey)) {
		const resource = scope === 'card' ? cardCache.get(resourceId) : await getDataset(resourceId);
		const owners = resource === null || resource === undefined ? null : resource.owners;
		const result = await resolveDestination(owners, { scope, id: resourceId }, ctx);
		destinationCache.set(cacheKey, {
			resourceName: resource ? resource.name : null,
			owners: owners || [],
			...result
		});
	}

	const cached = destinationCache.get(cacheKey);
	plan.resourceName = cached.resourceName;
	plan.owners = cached.owners;
	plan.destination = cached.userId;
	plan.rule = cached.rule;
	if (cached.note) notes.push(cached.note);
	plan.note = notes.length > 0 ? notes.join('; ') : null;

	if (plan.destination === ctx.fromUserId) {
		plan.destination = null;
		plan.rule = 'already-owned-by-source';
	}
	return plan;
}

async function bulkUpdate(updates) {
	try {
		await api.post('/query/v1/functions/bulk/template', { update: updates });
		return true;
	} catch (err) {
		errors.push({ label: `bulk update ${updates.map((u) => u.id).join(',')}`, error: err.message });
		return false;
	}
}

async function readUpdate(id, toUserId) {
	const template = await safe(`read template ${id}`, () => api.get(`/query/v1/functions/template/${id}?hidden=true`));
	if (!template) return null;
	// Only `owner` may move. Echoing the links back exactly as the server holds them
	// leaves expression, checkSum, legacyId and status untouched, and omitting them
	// entirely makes the endpoint return HTTP 500.
	return { id: template.id, owner: Number(toUserId), links: template.links || [] };
}

async function transferToOwner(plans, toUserId, batchSize) {
	const transferred = [];
	const failed = [];

	for (let i = 0; i < plans.length; i += batchSize) {
		const chunk = plans.slice(i, i + batchSize);
		const updates = [];
		for (const plan of chunk) {
			const update = await readUpdate(plan.id, toUserId);
			if (update) updates.push({ plan, update });
			else failed.push({ plan, error: 'could not re-read template' });
			await delay(CALL_DELAY);
		}
		if (updates.length === 0) continue;

		if (await bulkUpdate(updates.map((u) => u.update))) {
			transferred.push(...updates.map((u) => u.plan));
		} else {
			console.log(`    Batch failed, retrying ${updates.length} beast mode(s) individually...`);
			for (const { plan, update } of updates) {
				let ok = await bulkUpdate([update]);
				if (!ok) {
					// "Function links cannot be updated using the update template endpoint"
					// shows up transiently and clears on a retry with freshly read links.
					const fresh = await readUpdate(plan.id, toUserId);
					if (fresh) ok = await bulkUpdate([fresh]);
				}
				if (ok) transferred.push(plan);
				else failed.push({ plan, error: 'bulk update rejected the beast mode twice' });
				await delay(CALL_DELAY);
			}
		}
		await delay(BATCH_DELAY);
	}

	return { transferred, failed };
}

// Domo reports success on the write call and the search index that discovery uses
// lags ownership writes, so "the command said 40" and "40 beast modes changed hands"
// are different claims. This checks the second one, per beast mode, against the API.
async function verifyTransfers(plans) {
	const problems = [];
	let confirmed = 0;
	for (const plan of plans) {
		const template = await safe(`verify ${plan.id}`, () =>
			api.get(`/query/v1/functions/template/${plan.id}?hidden=true`)
		);
		if (!template) {
			problems.push({ id: plan.id, name: plan.name, issue: 'could not re-read after transfer' });
			continue;
		}
		const owner = template.owner && template.owner.id != null ? template.owner.id : template.owner;
		if (owner == null) problems.push({ id: plan.id, name: plan.name, issue: 'OWNERLESS after transfer' });
		else if (String(owner) !== String(plan.destination)) {
			problems.push({ id: plan.id, name: plan.name, issue: `owner is ${owner}, expected ${plan.destination}` });
		} else confirmed++;
		await delay(CALL_DELAY);
	}
	return { confirmed, problems };
}

function writePlanCsv(outputFile, plans) {
	const header = [
		'Beast Mode ID',
		'Beast Mode Name',
		'Scope',
		'Resource ID',
		'Resource Name',
		'Resource Owner IDs',
		'Resource Owner Types',
		'Destination User ID',
		'Destination User Name',
		'Rule',
		'Note',
		'Status'
	];
	let out = csvRow(header);
	for (const plan of plans) {
		const destination = plan.destination ? userCache.get(String(plan.destination)) : null;
		out += csvRow([
			plan.id,
			plan.name,
			plan.scope || '',
			plan.resourceId || '',
			plan.resourceName || '',
			plan.owners.map((o) => o.id).join(' '),
			plan.owners.map((o) => o.type || 'USER').join(' '),
			plan.destination || '',
			destination ? destination.displayName : '',
			plan.rule || '',
			plan.note || '',
			plan.status || ''
		]);
	}
	fs.writeFileSync(outputFile, out);
	console.log(`\nRouting plan written to ${outputFile}`);
}

function summarizeRules(plans) {
	const counts = new Map();
	for (const plan of plans) counts.set(plan.rule, (counts.get(plan.rule) || 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function buildPlans(templates, ctx) {
	const scopes = templates.map(classify);
	const idsFor = (scope) => [...new Set(scopes.filter((c) => c.scope === scope).map((c) => c.id))];

	const uncachedCards = idsFor('card').filter((id) => !cardCache.has(id));
	if (uncachedCards.length > 0) {
		console.log(`  Reading ${uncachedCards.length} card(s)...`);
		await loadCards(uncachedCards);
	}

	const datasetIds = idsFor('dataset');
	const uncachedDatasets = datasetIds.filter((id) => !datasetCache.has(id));
	if (uncachedDatasets.length > 0) {
		console.log(`  Reading ${uncachedDatasets.length} dataset(s)...`);
		for (let i = 0; i < uncachedDatasets.length; i++) {
			await getDataset(uncachedDatasets[i]);
			process.stdout.write(`  Read ${i + 1}/${uncachedDatasets.length} dataset(s)...\r`);
		}
	}

	// Only a group-owned dataset needs its producing dataflow, and one SQL query
	// answers every one of them at once.
	const groupOwned = datasetIds.filter((id) => {
		const dataset = datasetCache.get(id);
		return dataset && dataset.owners.some((o) => o.type === 'GROUP');
	});
	if (groupOwned.length > 0) {
		console.log(`  Resolving producing dataflows for ${groupOwned.length} group-owned dataset(s)...`);
		await loadDataflowOwners(groupOwned, ctx.dataflowMapDataset);
	}

	const plans = [];
	for (let i = 0; i < templates.length; i++) {
		plans.push(await routeBeastMode(templates[i], ctx));
		if ((i + 1) % 100 === 0) process.stdout.write(`  Routed ${i + 1}/${templates.length}...\r`);
	}
	return plans;
}

function printPreview(plans) {
	const datasetScoped = plans.filter((p) => p.scope === 'dataset').length;
	const cardScoped = plans.filter((p) => p.scope === 'card').length;
	console.log(`\n  ${plans.length} beast mode(s): ${datasetScoped} dataset-scoped, ${cardScoped} card-scoped`);

	console.log('\nRouting:');
	for (const [rule, count] of summarizeRules(plans)) {
		console.log(`  ${String(rule).padEnd(34)} ${String(count).padStart(5)}`);
	}

	const routable = plans.filter((p) => p.destination);
	const byDestination = new Map();
	for (const plan of routable) byDestination.set(plan.destination, (byDestination.get(plan.destination) || 0) + 1);
	if (byDestination.size > 0) {
		console.log(`\nDestinations (${byDestination.size}):`);
		const sorted = [...byDestination.entries()].sort((a, b) => b[1] - a[1]);
		for (const [id, count] of sorted.slice(0, PREVIEW_LIMIT)) {
			console.log(`  ${String(count).padStart(5)}  ${userLabel(id)}`);
		}
		if (sorted.length > PREVIEW_LIMIT) console.log(`  ... and ${sorted.length - PREVIEW_LIMIT} more`);
	}

	const unroutable = plans.filter((p) => !p.destination && p.rule !== 'already-owned-by-source');
	if (unroutable.length > 0) {
		console.log(`\nNot routable (${unroutable.length}, left with the current owner):`);
		for (const plan of unroutable.slice(0, PREVIEW_LIMIT)) {
			const where = plan.scope ? `${plan.scope} ${plan.resourceId}` : 'no card or dataset link';
			console.log(`  ${plan.id.padEnd(10)} ${String(plan.name).slice(0, 45).padEnd(45)} ${plan.rule} (${where})`);
		}
		if (unroutable.length > PREVIEW_LIMIT) console.log(`  ... and ${unroutable.length - PREVIEW_LIMIT} more`);
	}
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const fromUser = argv['from-user'] || argv.u;
	if (!fromUser) {
		console.error('Error: --from-user is required. Run with --help for usage.');
		process.exit(1);
	}
	const fromUserId = String(fromUser);
	const max = parseInt(argv.max || argv.m || '0', 10) || 0;
	const batchSize = parseInt(argv['batch-size'] || argv.b || '50', 10);
	const outputFile = argv.output || argv.o || null;
	const dataflowMapOverride = argv['dataflow-map-dataset'] || null;
	const allowInactiveOwner = Boolean(argv['allow-inactive-owner']);
	const verify = Boolean(argv.verify);
	const dryRun = Boolean(argv['dry-run'] || argv.dry);
	const skipPrompt = Boolean(argv.yes || argv.y);

	const logger = createLogger('transferBeastModesToContentOwners', {
		debugMode: false,
		dryRun,
		runMeta: { fromUser: fromUserId, max: max || null, batchSize, allowInactiveOwner, verify }
	});

	console.log('Transfer Beast Modes To Content Owners');
	console.log('======================================\n');
	if (dryRun) console.log('*** DRY RUN — no beast modes will be transferred ***\n');

	const fromUserRecord = await getUser(fromUserId);
	// reportsTo is blank on terminated and integration accounts, which is exactly when
	// this command tends to be run, so --manager is the supported way to supply it.
	const managerId = argv.manager ? String(argv.manager) : await getManagerId(fromUserId);
	if (managerId) await getUser(managerId);
	const dataflowMapDataset = await resolveDataflowMapDataset(dataflowMapOverride);

	console.log(`Instance:       ${config.instanceUrl}`);
	console.log(`From user:      ${fromUserRecord ? `${fromUserRecord.displayName} (${fromUserId})` : fromUserId}`);
	console.log(`Manager:        ${managerId ? userLabel(managerId) : '(none on record)'}`);
	console.log(`DataFlow map:   ${dataflowMapDataset || '(not found — the producing dataflow rule is skipped)'}`);
	console.log(`Max:            ${max || '(no limit)'}`);
	console.log(`Batch size:     ${batchSize}`);
	console.log(`Inactive owner: ${allowInactiveOwner ? 'allowed as a destination' : 'skipped'}`);

	const ctx = { allowInactiveOwner, dataflowMapDataset, fromUserId, managerId };
	const summary = { found: 0, transferred: 0, skipped: 0, unroutable: 0, failed: 0 };
	const allPlans = [];
	const attempted = new Set();

	for (let pass = 1; pass <= MAX_PASSES; pass++) {
		console.log(`\n=== Pass ${pass} ===`);
		console.log(`Searching for beast modes owned by ${fromUserId}...`);
		let templates = (await findBeastModes(fromUserId)).filter((t) => !attempted.has(String(t.id)));
		if (templates.length === 0) {
			if (pass === 1) console.log('  No beast modes found.');
			else console.log('  Nothing left to transfer.');
			break;
		}
		if (max) {
			const room = max - summary.found;
			if (room <= 0) break;
			templates = templates.slice(0, room);
		}
		summary.found += templates.length;
		console.log(`  Found ${templates.length} beast mode(s)`);

		console.log('\nResolving card and dataset owners...');
		const plans = await buildPlans(templates, ctx);
		printPreview(plans);

		const routable = plans.filter((p) => p.destination);
		for (const plan of plans) {
			if (!plan.destination) {
				plan.status = plan.rule === 'already-owned-by-source' ? 'skipped' : 'unroutable';
				if (plan.rule === 'already-owned-by-source') summary.skipped++;
				else summary.unroutable++;
			}
		}

		if (dryRun) {
			for (const plan of routable) plan.status = 'dry-run';
			allPlans.push(...plans);
			break;
		}

		if (routable.length === 0) {
			allPlans.push(...plans);
			break;
		}

		if (pass === 1 && !skipPrompt) {
			const answer = await ask(`\nTransfer ${routable.length} beast mode(s) to the destinations above? (yes/no): `);
			if (answer !== 'yes' && answer !== 'y') {
				console.log('Aborted. No changes were made.');
				process.exit(0);
			}
		}

		for (const template of templates) attempted.add(String(template.id));

		const byDestination = new Map();
		for (const plan of routable) {
			if (!byDestination.has(plan.destination)) byDestination.set(plan.destination, []);
			byDestination.get(plan.destination).push(plan);
		}

		console.log(`\nTransferring ${routable.length} beast mode(s) to ${byDestination.size} owner(s)...\n`);
		let index = 0;
		for (const [destination, items] of byDestination) {
			index++;
			console.log(`[${index}/${byDestination.size}] ${userLabel(destination)} — ${items.length} beast mode(s)`);
			const { transferred, failed } = await transferToOwner(items, destination, batchSize);
			for (const plan of transferred) plan.status = 'transferred';
			for (const { plan, error } of failed) {
				plan.status = 'error';
				plan.error = error;
			}
			summary.transferred += transferred.length;
			summary.failed += failed.length;
			console.log(`  ✓ ${transferred.length} transferred${failed.length ? `, ✗ ${failed.length} failed` : ''}`);
		}

		allPlans.push(...plans);
	}

	if (verify && !dryRun) {
		const transferred = allPlans.filter((p) => p.status === 'transferred');
		if (transferred.length > 0) {
			console.log(`\n=== Verify ===`);
			const { confirmed, problems } = await verifyTransfers(transferred);
			summary.verified = confirmed;
			summary.verifyProblems = problems.length;
			console.log(`  ${confirmed}/${transferred.length} confirmed with the new owner`);
			for (const problem of problems.slice(0, PREVIEW_LIMIT)) {
				console.log(`  ✗ ${problem.id} "${problem.name}": ${problem.issue}`);
			}
			if (problems.length > PREVIEW_LIMIT) console.log(`  ... and ${problems.length - PREVIEW_LIMIT} more`);
		}
	}

	for (const plan of allPlans) {
		logger.addResult({
			id: plan.id,
			name: plan.name,
			scope: plan.scope,
			resourceId: plan.resourceId,
			resourceName: plan.resourceName,
			owners: plan.owners,
			destination: plan.destination,
			rule: plan.rule,
			note: plan.note,
			status: plan.status,
			error: plan.error || null
		});
	}

	if (outputFile) writePlanCsv(outputFile, allPlans);

	console.log('\n=== Summary ===');
	console.log(`Found:       ${summary.found}`);
	console.log(`Transferred: ${summary.transferred}`);
	console.log(`Already owned by the resource owner: ${summary.skipped}`);
	console.log(`Not routable: ${summary.unroutable}`);
	console.log(`Failed:      ${summary.failed}`);
	if (summary.verified != null) console.log(`Verified:    ${summary.verified}`);
	if (errors.length > 0) console.log(`API errors logged: ${errors.length}`);

	logger.writeRunLog({ ...summary, apiErrors: errors });

	if (summary.failed > 0 || summary.verifyProblems > 0) {
		console.error('\nSome beast modes did not transfer. Check the messages above and the run log.');
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
