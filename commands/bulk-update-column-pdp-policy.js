/**
 * Update a column PDP (Personalized Data Permission) policy on a dataset.
 *
 * Fetches a filter group by --filter-group-id, finds the column policy by --policy-id,
 * adds/removes users and groups, validates all IDs are active, and PUTs back.
 *
 * Usage:
 *   node cli.js bulk-update-column-pdp-policy --dataset-id "<id>" --filter-group-id 704911 --policy-id 22 --add-users "111,222"
 *   node cli.js bulk-update-column-pdp-policy --dataset-id "<id>" --filter-group-id 704911 --policy-id 22 --add-groups "333,444"
 *   node cli.js bulk-update-column-pdp-policy --dataset-id "<id>" --filter-group-id 704911 --policy-id 22 --remove-users "111" --remove-groups "333"
 *   node cli.js bulk-update-column-pdp-policy --dataset-id "<id>" --filter-group-id 704911 --policy-id 22 --add-users "555" --remove-users "111"
 *
 * Options:
 *   --dataset-id       DataSet ID (required)
 *   --filter-group-id  Filter group ID (required)
 *   --policy-id        Column policy ID within the filter group (required)
 *   --add-users        Comma-separated user IDs to add
 *   --add-groups       Comma-separated group IDs to add
 *   --remove-users     Comma-separated user IDs to remove
 *   --remove-groups    Comma-separated group IDs to remove
 */

const api = require('../lib/api');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage:
  node cli.js bulk-update-column-pdp-policy --dataset-id "<id>" --filter-group-id 704911 --policy-id 22 --add-users "111,222"
  node cli.js bulk-update-column-pdp-policy --dataset-id "<id>" --filter-group-id 704911 --policy-id 22 --add-groups "333,444"
  node cli.js bulk-update-column-pdp-policy --dataset-id "<id>" --filter-group-id 704911 --policy-id 22 --remove-users "111" --remove-groups "333"
  node cli.js bulk-update-column-pdp-policy --dataset-id "<id>" --filter-group-id 704911 --policy-id 22 --add-users "555" --remove-users "111"

Options:
  --dataset-id       DataSet ID (required)
  --filter-group-id  Filter group ID (required)
  --policy-id        Column policy ID within the filter group (required)
  --add-users        Comma-separated user IDs to add
  --add-groups       Comma-separated group IDs to add
  --remove-users     Comma-separated user IDs to remove
  --remove-groups    Comma-separated group IDs to remove`;

function parseIdList(value) {
	if (!value) return [];
	return String(value)
		.split(',')
		.map((id) => parseInt(id.trim(), 10))
		.filter((id) => !isNaN(id));
}

async function getFilterGroup(datasetId, filterGroupId) {
	return api.get(
		`/query/v2/data-control/${datasetId}/policy-group/${filterGroupId}`
	);
}

async function updateFilterGroup(datasetId, filterGroupId, body) {
	return api.put(
		`/query/v2/data-control/${datasetId}/policy-group/${filterGroupId}`,
		body
	);
}

async function validateUserIds(userIds) {
	const users = await api.get(
		`/content/v3//users?active=true&id=${userIds.join(',')}`
	);
	const activeIds = new Set(users.map((u) => u.id));

	const active = [];
	const removed = [];

	for (const id of userIds) {
		if (activeIds.has(id)) {
			active.push(id);
		} else {
			removed.push({ id, reason: 'not found or inactive' });
			console.log(`    Removing user ${id} (not found or inactive)`);
		}
	}

	return { active, removed };
}

async function validateGroupIds(groupIds) {
	const groups = await api.post(
		`/content/v2/groups/get?includeActive=true&includeUsers=false`,
		groupIds.map(String)
	);
	const groupMap = new Map(groups.map((g) => [g.id, g]));

	const active = [];
	const removed = [];

	for (const id of groupIds) {
		const group = groupMap.get(id);
		if (group && group.active) {
			active.push(id);
		} else {
			const reason = !group ? 'not found' : 'inactive/deleted';
			removed.push({ id, reason });
			console.log(`    Removing group ${id} (${reason})`);
		}
	}

	return { active, removed };
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const datasetId = argv['dataset-id'];
	const filterGroupId = parseInt(argv['filter-group-id'], 10);
	const policyId = parseInt(argv['policy-id'], 10);
	const addUsers = parseIdList(argv['add-users']);
	const addGroups = parseIdList(argv['add-groups']);
	const removeUsers = parseIdList(argv['remove-users']);
	const removeGroups = parseIdList(argv['remove-groups']);

	if (!datasetId || isNaN(filterGroupId) || isNaN(policyId)) {
		console.error(
			'Error: --dataset-id, --filter-group-id, and --policy-id are required\n'
		);
		console.error(HELP_TEXT);
		process.exit(1);
	}

	if (
		addUsers.length === 0 &&
		addGroups.length === 0 &&
		removeUsers.length === 0 &&
		removeGroups.length === 0
	) {
		console.error(
			'Error: At least one of --add-users, --add-groups, --remove-users, --remove-groups is required'
		);
		process.exit(1);
	}

	console.log('Update PDP Column Policy');
	console.log('========================\n');
	console.log(`DataSet ID:      ${datasetId}`);
	console.log(`Filter Group ID: ${filterGroupId}`);
	console.log(`Policy ID:       ${policyId}`);
	if (addUsers.length) console.log(`Add users:       ${addUsers.join(', ')}`);
	if (addGroups.length) console.log(`Add groups:      ${addGroups.join(', ')}`);
	if (removeUsers.length)
		console.log(`Remove users:    ${removeUsers.join(', ')}`);
	if (removeGroups.length)
		console.log(`Remove groups:   ${removeGroups.join(', ')}`);

	// Fetch the filter group
	console.log('\nFetching filter group...');
	const filterGroup = await getFilterGroup(datasetId, filterGroupId);
	console.log(`Filter group: "${filterGroup.name}"`);

	// Find the target column policy
	const columnPolicies = filterGroup.columnPolicies || [];
	const policy = columnPolicies.find((p) => p.policyId === policyId);

	if (!policy) {
		const available = columnPolicies
			.map((p) => `${p.policyId} (${p.values?.join(', ') || 'no values'})`)
			.join('; ');
		console.error(
			`\nError: Policy ID ${policyId} not found. Available column policies: ${available}`
		);
		process.exit(1);
	}

	console.log(
		`Found column policy ${policyId}: values=[${(policy.values || []).join(', ')}]`
	);
	console.log(
		`  Current users:  [${(policy.userIds || []).length}] ${(policy.userIds || []).join(', ')}`
	);
	console.log(
		`  Current groups: [${(policy.groupIds || []).length}] ${(policy.groupIds || []).join(', ')}`
	);

	// Build new user/group lists
	let userIds = new Set(policy.userIds || []);
	let groupIds = new Set(policy.groupIds || []);

	// Apply additions
	for (const id of addUsers) userIds.add(id);
	for (const id of addGroups) groupIds.add(id);

	// Apply removals
	for (const id of removeUsers) userIds.delete(id);
	for (const id of removeGroups) groupIds.delete(id);

	// Validate all user/group IDs
	const allUserIds = [...userIds];
	const allGroupIds = [...groupIds];

	if (allUserIds.length > 0) {
		console.log(`\nValidating ${allUserIds.length} user(s)...`);
		const userResult = await validateUserIds(allUserIds);
		userIds = new Set(userResult.active);
		if (userResult.removed.length > 0) {
			console.log(`  Removed ${userResult.removed.length} invalid user(s)`);
		} else {
			console.log('  All users valid');
		}
	}

	if (allGroupIds.length > 0) {
		console.log(`\nValidating ${allGroupIds.length} group(s)...`);
		const groupResult = await validateGroupIds(allGroupIds);
		groupIds = new Set(groupResult.active);
		if (groupResult.removed.length > 0) {
			console.log(`  Removed ${groupResult.removed.length} invalid group(s)`);
		} else {
			console.log('  All groups valid');
		}
	}

	// Update the target column policy in place
	policy.userIds = [...userIds];
	policy.groupIds = [...groupIds];

	console.log('\nUpdating filter group...');
	console.log(
		`  Final users:  [${policy.userIds.length}] ${policy.userIds.join(', ')}`
	);
	console.log(
		`  Final groups: [${policy.groupIds.length}] ${policy.groupIds.join(', ')}`
	);

	await updateFilterGroup(datasetId, filterGroupId, filterGroup);
	console.log('\nPolicy updated successfully!');
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});
