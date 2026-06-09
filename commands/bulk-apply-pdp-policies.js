/**
 * Copy PDP (Personalized Data Permission) policies from a source DataSet
 * to every DataSet listed in a CSV file.
 *
 * The script reads all non-open PDP policies from the source DataSet, then
 * enables PDP and applies matching policies on each target DataSet.
 *
 * By default, policies are added on top of whatever already exists on the
 * target — a policy whose name matches an existing one is updated in place,
 * and any others are created. Pass --clean to instead delete all existing
 * custom policies first and write only the source set.
 *
 * Usage:
 *   node cli.js bulk-apply-pdp-policies --file "datasets.csv" --source-dataset-id "SRC_ID" --allowed-columns "ae_email,sc_email"
 *   node cli.js bulk-apply-pdp-policies --file "datasets.csv" --column "DataSet ID" --source-dataset-id "SRC_ID" --allowed-columns "ae_email"
 *   node cli.js bulk-apply-pdp-policies --file "datasets.csv" --all-rows-users "123,456" --all-rows-groups "789" --source-dataset-id "SRC_ID" --allowed-columns "ae_email"
 *   node cli.js bulk-apply-pdp-policies --dataset-id "TARGET_ID" --source-dataset-id "SRC_ID" --allowed-columns "ae_email,sc_email"
 *   node cli.js bulk-apply-pdp-policies --dataset-ids "id1,id2,id3" --source-dataset-id "SRC_ID" --allowed-columns "ae_email"
 *
 * Options:
 *   --file, -f          CSV file with target dataset IDs
 *   --dataset-id        Single target dataset ID (enables debug logging)
 *   --dataset-ids       Comma-separated target dataset IDs
 *   --column, -c        CSV column name containing dataset IDs (default: "DataSet ID")
 *   --source-dataset-id Source dataset to copy PDP policies from (required)
 *   --allowed-columns   Comma-separated list of allowed PDP filter columns (optional; copies all policies if omitted)
 *   --all-rows-users    Comma-separated user IDs to assign to the All Rows policy
 *   --all-rows-groups   Comma-separated group IDs to assign to the All Rows policy
 *   --clean             Delete all existing custom policies before writing the new set
 */

const { api, resolveIds, createLogger, showHelp } = require('../lib');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js bulk-apply-pdp-policies [options]

Options:
  --file, -f          CSV file with target dataset IDs
  --dataset-id        Single target dataset ID
  --dataset-ids       Comma-separated target dataset IDs
  --column, -c        CSV column with dataset IDs (default: "DataSet ID")
  --source-dataset-id Source dataset to copy policies from (required)
  --allowed-columns   Allowed PDP filter columns, comma-separated (optional; copies all policies if omitted)
  --all-rows-users    User IDs for the All Rows policy
  --all-rows-groups   Group IDs for the All Rows policy
  --clean             Delete existing custom policies first (default: add/update in place)`;


async function getPdpPolicies(datasetId) {
	return api.get(
		`/query/v1/data-control/${datasetId}/filter-groups?options=load_associations,include_open_policy,load_filters,sort`
	);
}

async function enablePdp(datasetId) {
	return api.put(`/query/v1/data-control/${datasetId}`, {
		enabled: true,
		enabledColumn: false,
		external: false,
		secured: false
	});
}

async function updatePdpPolicy(datasetId, policyId, policy) {
	return api.put(
		`/query/v1/data-control/${datasetId}/filter-groups/${policyId}`,
		policy
	);
}

async function deletePdpPolicy(datasetId, policyId) {
	return api.del(
		`/query/v1/data-control/${datasetId}/filter-groups/${policyId}`
	);
}

function buildPolicyBody(datasetId, policy) {
	return {
		dataSourceId: datasetId,
		dataSourcePermissions: policy.dataSourcePermissions || false,
		name: policy.name,
		parameters: (policy.parameters || []).map((p) => ({
			ignoreCase: p.ignoreCase || false,
			name: p.name,
			operator: p.operator,
			type: p.type,
			values: p.values || []
		})),
		userIds: policy.userIds || [],
		groupIds: policy.groupIds || [],
		virtualUserIds: policy.virtualUserIds || []
	};
}

async function createPdpPolicy(datasetId, policy) {
	return api.post(
		`/query/v1/data-control/${datasetId}/filter-groups`,
		buildPolicyBody(datasetId, policy)
	);
}

async function main() {
	showHelp(argv, HELP_TEXT);

	const sourceDatasetId = argv['source-dataset-id'] || argv.s;
	if (!sourceDatasetId) {
		console.error('Error: --source-dataset-id is required.');
		process.exit(1);
	}

	const clean = Boolean(argv.clean);
	const allowedColumns = argv['allowed-columns']
		? String(argv['allowed-columns'])
				.split(',')
				.map((c) => c.trim())
				.filter(Boolean)
		: [];
	const allRowsUserIds = argv['all-rows-users']
		? String(argv['all-rows-users'])
				.split(',')
				.map((id) => Number(id.trim()))
				.filter(Boolean)
		: [];
	const allRowsGroupIds = argv['all-rows-groups']
		? String(argv['all-rows-groups'])
				.split(',')
				.map((id) => Number(id.trim()))
				.filter(Boolean)
		: [];

	const { ids: datasetIds, debugMode } = resolveIds(argv, {
		name: 'dataset',
		columnDefault: 'DataSet ID'
	});

	const logger = createLogger('bulk-apply-pdp-policies', {
		debugMode,
		runMeta: { sourceDatasetId, allowedColumns, allRowsUserIds, allRowsGroupIds, clean }
	});

	console.log('Bulk Apply PDP Policies');
	console.log('=======================\n');

	// Step 1: Read source PDP policies
	console.log(`Fetching PDP policies from source dataset: ${sourceDatasetId}`);
	const sourcePolicies = await getPdpPolicies(sourceDatasetId);

	// The source "All Rows" (open) policy — used as the fallback assignment for
	// the target's All Rows policy when no --all-rows-users/-groups are given.
	const sourceAllRows = sourcePolicies.find((p) => !p.dataSourcePermissions);

	// Keep custom policies. If allowed columns were specified, restrict to
	// policies that filter on one of those columns; otherwise copy all of them.
	const policiesToCopy = sourcePolicies.filter((p) => {
		if (!p.dataSourcePermissions) return false;
		if (allowedColumns.length === 0) return true;
		const paramColumns = (p.parameters || []).map((param) => param.name);
		return paramColumns.some((col) => allowedColumns.includes(col));
	});

	if (policiesToCopy.length === 0) {
		console.log(
			allowedColumns.length > 0
				? `\nNo PDP policies found matching columns [${allowedColumns.join(', ')}]. Nothing to copy.`
				: '\nNo custom PDP policies found on the source dataset. Nothing to copy.'
		);
		logger.writeRunLog({ total: datasetIds.length, applied: 0, errors: 0 });
		process.exit(0);
	}

	console.log(
		`Found ${sourcePolicies.length} total policies (${policiesToCopy.length} to copy):\n`
	);
	for (const policy of policiesToCopy) {
		const filters = (policy.parameters || [])
			.map(
				(p) =>
					`${p.name} ${p.operator} ${p.type === 'DYNAMIC' ? p.values.join(', ') : `[${p.values.length} values]`}`
			)
			.join(' AND ');
		const users = (policy.userIds || []).length;
		const groups = (policy.groupIds || []).length;
		console.log(`  - "${policy.name}" (${users} users, ${groups} groups)`);
		if (filters) console.log(`    Filters: ${filters}`);
	}

	console.log(`\nTarget datasets: ${datasetIds.length}`);

	// Step 2: Apply policies to each target dataset
	console.log(`\nProcessing ${datasetIds.length} dataset(s)...\n`);

	let successCount = 0;
	let errorCount = 0;

	for (let i = 0; i < datasetIds.length; i++) {
		const targetId = datasetIds[i];
		console.log(`[${i + 1}/${datasetIds.length}] ${targetId}`);

		try {
			// Enable PDP on the target dataset
			await enablePdp(targetId);
			console.log('  PDP enabled');

			// Fetch existing policies. In clean mode, delete all custom ones so
			// the target ends up with exactly the source set. Otherwise leave
			// them in place and update/create by name below.
			const policies = await getPdpPolicies(targetId);
			const existingCustom = policies.filter((p) => p.dataSourcePermissions);
			if (clean) {
				for (const old of existingCustom) {
					await deletePdpPolicy(targetId, old.filterGroupId);
					console.log(`  Deleted existing policy: "${old.name}"`);
					await new Promise((resolve) => setTimeout(resolve, 150));
				}
			}

			// Update the "All Rows" policy to assign the designated group
			const allRowsPolicy = policies.find((p) => !p.dataSourcePermissions);
			if (!allRowsPolicy) {
				throw new Error(
					'Could not find the All Rows policy after enabling PDP'
				);
			}
			const allRowsUpdate = {
				...allRowsPolicy,
				dataSourceId: targetId
			};
			// Assignment precedence: explicit flags win; otherwise in default
			// (non-clean) mode fall back to the source dataset's All Rows
			// assignment so it carries over.
			let effectiveAllRowsUsers = allRowsUserIds;
			let effectiveAllRowsGroups = allRowsGroupIds;
			if (
				!clean &&
				allRowsUserIds.length === 0 &&
				allRowsGroupIds.length === 0 &&
				sourceAllRows
			) {
				effectiveAllRowsUsers = sourceAllRows.userIds || [];
				effectiveAllRowsGroups = sourceAllRows.groupIds || [];
			}
			if (effectiveAllRowsUsers.length > 0)
				allRowsUpdate.userIds = effectiveAllRowsUsers;
			if (effectiveAllRowsGroups.length > 0)
				allRowsUpdate.groupIds = effectiveAllRowsGroups;
			await updatePdpPolicy(
				targetId,
				allRowsPolicy.filterGroupId,
				allRowsUpdate
			);
			console.log(
				`  Updated "All Rows" policy — users: [${effectiveAllRowsUsers}], groups: [${effectiveAllRowsGroups}]`
			);
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Apply each policy. In clean mode the custom policies were just
			// deleted, so everything is created fresh. Otherwise, update any
			// existing policy with a matching name and create the rest.
			const existingByName = new Map(
				(clean ? [] : existingCustom).map((p) => [p.name, p])
			);
			for (const policy of policiesToCopy) {
				const match = existingByName.get(policy.name);
				if (match) {
					await updatePdpPolicy(targetId, match.filterGroupId, {
						...buildPolicyBody(targetId, policy),
						filterGroupId: match.filterGroupId
					});
					console.log(`  Updated policy: "${policy.name}"`);
				} else {
					await createPdpPolicy(targetId, policy);
					console.log(`  Created policy: "${policy.name}"`);
				}
				await new Promise((resolve) => setTimeout(resolve, 150));
			}

			console.log('  Done');
			logger.addResult({ datasetId: targetId, status: 'applied' });
			if (debugMode)
				logger.writeDebugLog(targetId, { datasetId: targetId, status: 'applied' });
			successCount++;
		} catch (error) {
			console.error(`  Error: ${error.message}`);
			logger.addResult({ datasetId: targetId, status: 'error', error: error.message });
			if (debugMode)
				logger.writeDebugLog(targetId, {
					datasetId: targetId,
					status: 'error',
					error: error.message
				});
			errorCount++;
		}

		// Rate-limit between datasets
		if (i + 1 < datasetIds.length) {
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}

	// Summary
	console.log('\n=== Summary ===');
	console.log(`Total target datasets: ${datasetIds.length}`);
	console.log(`Successfully applied:  ${successCount}`);
	console.log(`Errors:                ${errorCount}`);
	console.log(
		clean
			? `Policies per dataset:  ${policiesToCopy.length + 1} (${policiesToCopy.length} filtered + All Rows)`
			: `Policies applied/dataset: ${policiesToCopy.length} (added or updated by name) + All Rows`
	);

	logger.writeRunLog({
		total: datasetIds.length,
		applied: successCount,
		errors: errorCount
	});

	if (errorCount > 0) {
		console.error('\nSome datasets failed. Check the error messages above.');
		process.exit(1);
	} else {
		console.log('\nAll PDP policies applied successfully!');
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
