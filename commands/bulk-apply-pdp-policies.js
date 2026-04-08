/**
 * Copy PDP (Personalized Data Permission) policies from a source DataSet
 * to every DataSet listed in a CSV file.
 *
 * The script reads all non-open PDP policies from the source DataSet, then
 * enables PDP and creates matching policies on each target DataSet.
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
 *   --allowed-columns   Comma-separated list of allowed PDP filter columns (required)
 *   --all-rows-users    Comma-separated user IDs to assign to the All Rows policy
 *   --all-rows-groups   Comma-separated group IDs to assign to the All Rows policy
 */

const api = require('../lib/api');
const { resolveIds } = require('../lib/input');
const argv = require('minimist')(process.argv.slice(2));


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

async function createPdpPolicy(datasetId, policy) {
	const body = {
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

	return api.post(
		`/query/v1/data-control/${datasetId}/filter-groups`,
		body
	);
}

async function main() {
	if (argv.help || argv.h) {
		console.log('Usage: node cli.js bulk-apply-pdp-policies [options]\n');
		console.log('Options:');
		console.log('  --file, -f          CSV file with target dataset IDs');
		console.log('  --dataset-id        Single target dataset ID');
		console.log('  --dataset-ids       Comma-separated target dataset IDs');
		console.log('  --column, -c        CSV column with dataset IDs (default: "DataSet ID")');
		console.log('  --source-dataset-id Source dataset to copy policies from (required)');
		console.log('  --allowed-columns   Allowed PDP filter columns, comma-separated (required)');
		console.log('  --all-rows-users    User IDs for the All Rows policy');
		console.log('  --all-rows-groups   Group IDs for the All Rows policy');
		process.exit(0);
	}

	const sourceDatasetId = argv['source-dataset-id'] || argv.s;
	if (!sourceDatasetId) {
		console.error('Error: --source-dataset-id is required.');
		process.exit(1);
	}

	if (!argv['allowed-columns']) {
		console.error('Error: --allowed-columns is required (comma-separated column names).');
		process.exit(1);
	}
	const allowedColumns = String(argv['allowed-columns'])
		.split(',')
		.map((c) => c.trim())
		.filter(Boolean);
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

	const { ids: datasetIds } = resolveIds(argv, {
		name: 'dataset',
		columnDefault: 'DataSet ID'
	});

	console.log('Bulk Apply PDP Policies');
	console.log('=======================\n');

	// Step 1: Read source PDP policies
	console.log(`Fetching PDP policies from source dataset: ${sourceDatasetId}`);
	const sourcePolicies = await getPdpPolicies(sourceDatasetId);

	// Keep only custom policies that filter on the allowed columns
	const policiesToCopy = sourcePolicies.filter((p) => {
		if (!p.dataSourcePermissions) return false;
		const paramColumns = (p.parameters || []).map((param) => param.name);
		return paramColumns.some((col) => allowedColumns.includes(col));
	});

	if (policiesToCopy.length === 0) {
		console.log(
			`\nNo PDP policies found matching columns [${allowedColumns.join(', ')}]. Nothing to copy.`
		);
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

			// Fetch existing policies and delete all custom ones
			const policies = await getPdpPolicies(targetId);
			const existingCustom = policies.filter((p) => p.dataSourcePermissions);
			for (const old of existingCustom) {
				await deletePdpPolicy(targetId, old.filterGroupId);
				console.log(`  Deleted existing policy: "${old.name}"`);
				await new Promise((resolve) => setTimeout(resolve, 150));
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
			if (allRowsUserIds.length > 0) allRowsUpdate.userIds = allRowsUserIds;
			if (allRowsGroupIds.length > 0) allRowsUpdate.groupIds = allRowsGroupIds;
			await updatePdpPolicy(
				targetId,
				allRowsPolicy.filterGroupId,
				allRowsUpdate
			);
			console.log(
				`  Updated "All Rows" policy — users: [${allRowsUserIds}], groups: [${allRowsGroupIds}]`
			);
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Create each filtered policy
			for (const policy of policiesToCopy) {
				await createPdpPolicy(targetId, policy);
				console.log(`  Created policy: "${policy.name}"`);
				await new Promise((resolve) => setTimeout(resolve, 150));
			}

			console.log('  Done');
			successCount++;
		} catch (error) {
			console.error(`  Error: ${error.message}`);
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
		`Policies per dataset:  ${policiesToCopy.length + 1} (${policiesToCopy.length} filtered + All Rows)`
	);

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
