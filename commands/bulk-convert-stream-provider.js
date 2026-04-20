/**
 * Convert all dataset streams from one connector to another, swapping provider,
 * account, transport, and configuration.
 *
 * For each stream's existing account owner:
 *   - If the owner already has an account of the target provider type, reuse it
 *   - Otherwise, create a new account with the provided credentials
 *
 * Required credential fields are discovered dynamically from the target provider's
 * authenticationSchemeConfiguration. Pass them as CLI args, or omit them to be
 * prompted interactively.
 *
 * Usage:
 *   node cli.js bulk-convert-stream-provider --from-connector "com.domo.connector.microsoft.sharepoint.online" --to-connector "com.domo.connector.microsoftsharepointonlinerest"
 *   node cli.js bulk-convert-stream-provider --from-connector "com.domo.connector.microsoft.sharepoint.online" --to-connector "com.domo.connector.microsoftsharepointonlinerest" --client_id "xxx" --client_secret "yyy"
 *   node cli.js bulk-convert-stream-provider --from-connector "com.domo.connector.microsoft.sharepoint.online" --to-connector "com.domo.connector.microsoftsharepointonlinerest" --client_id "xxx" --client_secret "yyy" --dry-run
 *   node cli.js bulk-convert-stream-provider --from-connector "com.domo.connector.microsoft.sharepoint.online" --to-connector "com.domo.connector.microsoftsharepointonlinerest" --client_id "xxx" --client_secret "yyy" --stream-id 123
 *
 * Options:
 *   --from-connector Source connector ID (required)
 *   --to-connector   Target connector ID (required)
 *   --stream-id      Process a single stream instead of all streams for the source provider
 *   --dry-run        Preview changes without applying them
 *   --<credential>   Any required credential fields for the target provider (e.g. --client_id, --client_secret)
 */

const api = require('../lib/api');
const { providerMap, instanceUrl } = require('../lib/index');
const { showHelp } = require('../lib/help');
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage:
  node cli.js bulk-convert-stream-provider --from-connector <connectorId> --to-connector <connectorId> [...fields] [--dry-run]

Options:
  --from-connector Source connector ID (required)
  --to-connector   Target connector ID (required)
  --stream-id      Process a single stream instead of all
  --dry-run        Preview changes without applying them
  --<credential>   Required credential fields for the target provider`;

showHelp(argv, HELP_TEXT);

const fromConnector = argv['from-connector'];
const toConnector = argv['to-connector'];
const dryRun = argv['dry-run'] || false;
const singleStreamId = argv['stream-id'];

if (!fromConnector || !toConnector) {
	console.error(
		'Usage: node cli.js bulk-convert-stream-provider --from-connector <connectorId> --to-connector <connectorId> [...fields] [--dry-run]'
	);
	process.exit(1);
}

// ── Interactive prompt ───────────────────────────────────────────────

function prompt(question) {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

// ── Configuration mapping ────────────────────────────────────────────

function loadConfigMapping(fromProviderKey, toProviderKey) {
	const allMappings = JSON.parse(providerMap);
	return allMappings[`${fromProviderKey}->${toProviderKey}`] || null;
}

// Named transform functions for field value conversions
const transforms = {
	extractSiteName: (value) => {
		const match = value.match(/\/sites\/([^/]+)/);
		if (!match) return value;
		const site = decodeURIComponent(match[1]);
		const hyphenIdx = site.lastIndexOf('-');
		return hyphenIdx !== -1 ? site.substring(hyphenIdx + 1) : site;
	},
	extractRelativePath: (value) => {
		const decoded = decodeURIComponent(value);
		const match = decoded.match(/\/sites\/[^/]+\/Shared Documents\/(.+)\/[^/]+$/);
		return match ? match[1] : value;
	}
};

function transformConfiguration(config, mapping, streamId) {
	const { fieldMappings, defaults } = mapping;
	const newConfig = [];
	const mappedTargetFields = new Set();

	for (const entry of config) {
		const rule = fieldMappings[entry.name];
		if (rule === undefined) continue; // drop unmapped fields

		if (typeof rule === 'string') {
			// Simple rename, keep value
			newConfig.push({
				streamId,
				category: entry.category,
				name: rule,
				type: entry.type,
				value: entry.value
			});
			mappedTargetFields.add(rule);
		} else {
			// Apply default transform if specified, then valueMap
			const defaultValue =
				rule.transform && transforms[rule.transform] ? transforms[rule.transform](entry.value) : entry.value;

			// Support single target or array of targets; entries can be strings
			// or objects with { name, transform } for per-target overrides
			const targets = Array.isArray(rule.to) ? rule.to : [rule.to];
			for (const target of targets) {
				let targetName, value;
				if (typeof target === 'object') {
					targetName = target.name;
					value =
						target.transform && transforms[target.transform] ? transforms[target.transform](entry.value) : defaultValue;
				} else {
					targetName = target;
					value = defaultValue;
				}
				value = rule.valueMap?.[value] ?? value;
				newConfig.push({
					streamId,
					category: entry.category,
					name: targetName,
					type: entry.type,
					value
				});
				mappedTargetFields.add(targetName);
			}
		}
	}

	// Add defaults for any target fields not already covered by a mapping
	for (const [name, value] of Object.entries(defaults || {})) {
		if (!mappedTargetFields.has(name)) {
			newConfig.push({
				streamId,
				category: 'METADATA',
				name,
				type: 'string',
				value
			});
		}
	}

	return newConfig;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
	// 1. Resolve providers and connector details from connector IDs
	console.log(`Resolving connectors...`);
	const [fromProvider, toProvider, fromConnectorDef, toConnectorDef] = await Promise.all([
		api.get(
			`/data/v1/providers/connector/${fromConnector}?fields=id,key,name,url,authenticationScheme,authenticationSchemeConfiguration,moduleHandler`
		),
		api.get(
			`/data/v1/providers/connector/${toConnector}?fields=id,key,name,url,authenticationScheme,authenticationSchemeConfiguration,moduleHandler`
		),
		api.get(`/data/v1/connectors/${fromConnector}?fields=all`),
		api.get(`/data/v1/connectors/${toConnector}?fields=all`)
	]);

	console.log(
		`  From: ${fromProvider.name} (${fromProvider.key}) via ${fromConnectorDef.id} v${fromConnectorDef.version.major}.${fromConnectorDef.version.minor}`
	);
	console.log(
		`  To:   ${toProvider.name} (${toProvider.key}) via ${toConnectorDef.id} v${toConnectorDef.version.major}.${toConnectorDef.version.minor}\n`
	);

	// Build target transport from connector definition
	const targetTransport = {
		type: 'CONNECTOR',
		description: toConnectorDef.id,
		version: `${toConnectorDef.version.major}.${toConnectorDef.version.minor}`
	};

	// 2. Load configuration mapping
	const configMapping = loadConfigMapping(fromProvider.key, toProvider.key);
	if (configMapping) {
		console.log(`Loaded config mapping: ${configMapping.description}\n`);
	} else {
		console.log(`No config mapping found for "${fromProvider.key}->${toProvider.key}" in providerMappings.json`);
		console.log('Stream configurations will be carried over as-is.\n');
	}

	// 3. Collect credential values — CLI args first, then prompt for missing required fields
	const schemaFields = toProvider.authenticationSchemeConfiguration || [];
	const requiredFields = schemaFields.filter((f) => f.required);

	const credentials = {};
	for (const field of schemaFields) {
		if (argv[field.name] !== undefined) {
			credentials[field.name] = String(argv[field.name]);
		}
	}

	const missingRequired = requiredFields.filter((f) => !credentials[f.name]);
	if (missingRequired.length > 0) {
		console.log('Required credential fields for new accounts:');
		for (const f of missingRequired) {
			const hint = f.tooltipText ? ` — ${f.tooltipText}` : '';
			console.log(`  ${f.text || f.name} (--${f.name})${hint}`);
		}
		console.log('');
		for (const f of missingRequired) {
			const label = f.text || f.name;
			const value = await prompt(`Enter ${label} (${f.name}): `);
			if (!value) {
				console.error(`Error: ${f.name} is required.`);
				process.exit(1);
			}
			credentials[f.name] = value;
		}
		console.log('');
	}

	// 4. Fetch all existing target-provider accounts, index by owner userId
	console.log(`Fetching existing "${toProvider.key}" accounts...`);
	const targetAccounts = await api.get(`/data/v1/accounts/provider/${toProvider.key}`);
	const ownerToAccount = {};
	for (const acc of targetAccounts) {
		if (!ownerToAccount[acc.userId]) {
			ownerToAccount[acc.userId] = acc;
		}
	}
	console.log(`  ${targetAccounts.length} account(s) across ${Object.keys(ownerToAccount).length} owner(s)\n`);

	// 5. Collect streams to process — single stream or all datasets for the source provider
	const streamEntries = [];
	if (singleStreamId) {
		console.log(`Using single stream ${singleStreamId}...`);
		const stream = await api.get(`/data/v1/streams/${singleStreamId}?fields=all`);
		streamEntries.push({
			streamId: singleStreamId,
			dataSourceName: stream.dataSource?.name || singleStreamId,
			dataSourceId: stream.dataSource?.id,
			prefetched: stream
		});
	} else {
		console.log(`Fetching datasets for provider "${fromProvider.key}"...`);
		let offset = 0;
		const PAGE_SIZE = 50;
		while (true) {
			const result = await api.get(
				`/data/v3/datasources?dataProviderType=${fromProvider.key}&limit=${PAGE_SIZE}&offset=${offset}`
			);
			const dataSources = result.dataSources || [];
			if (!dataSources.length) break;
			for (const ds of dataSources) {
				if (ds.streamId) {
					streamEntries.push({
						streamId: ds.streamId,
						dataSourceName: ds.name,
						dataSourceId: ds.id
					});
				}
			}
			offset += PAGE_SIZE;
			if (dataSources.length < PAGE_SIZE) break;
			await new Promise((r) => setTimeout(r, 150));
		}
	}
	console.log(`  Found ${streamEntries.length} stream(s) to process\n`);

	if (streamEntries.length === 0) {
		console.log('Nothing to convert.');
		return;
	}

	// 6. Process each stream
	let callerUserId = null;
	let successCount = 0;
	let errorCount = 0;
	const accountInfoCache = {};
	const createdAccountIds = [];

	for (let i = 0; i < streamEntries.length; i++) {
		const { streamId, dataSourceName, dataSourceId, prefetched } = streamEntries[i];
		console.log(`[${i + 1}/${streamEntries.length}] Stream ${streamId} — ${dataSourceName}`);

		try {
			// Fetch full stream definition (or reuse if already fetched)
			const stream = prefetched || (await api.get(`/data/v1/streams/${streamId}?fields=all`));

			// Resolve current account and determine owner
			let ownerId = null;
			let targetAccountId;
			const currentAccountId = stream.account?.id;
			if (currentAccountId) {
				if (!accountInfoCache[currentAccountId]) {
					accountInfoCache[currentAccountId] = await api.get(`/data/v1/accounts/${currentAccountId}`);
				}
				const currentAccount = accountInfoCache[currentAccountId];
				ownerId = currentAccount.userId;
				console.log(`  Current account: ${currentAccountId} (owner: ${ownerId})`);

				// If the account is already the target provider type, reuse it as-is
				if (currentAccount.dataProviderType === toProvider.key) {
					targetAccountId = currentAccountId;
					console.log(`  Account already target provider type, reusing: ${targetAccountId}`);
				}
			} else {
				console.log('  No existing account on stream');
			}

			// Verify the owner is an active user; fall back to dataset owner if not
			if (ownerId && !targetAccountId) {
				const ownerUser = await api.get(`/content/v2/users/${ownerId}`);
				if (!ownerUser.active) {
					const dsOwnerId = stream.dataSource?.owner?.id;
					console.log(`  Account owner ${ownerId} is deleted, falling back to dataset owner ${dsOwnerId}`);
					ownerId = dsOwnerId ? Number(dsOwnerId) : null;
				}
			}

			// Determine target account — one per owner so ownership can be transferred
			if (!targetAccountId && ownerId && ownerToAccount[ownerId]) {
				targetAccountId = ownerToAccount[ownerId].id;
				console.log(`  Owner already has target account: ${targetAccountId}`);
			} else if (!targetAccountId) {
				if (dryRun) {
					console.log('  [DRY RUN] Would create new account');
					targetAccountId = 0;
				} else {
					console.log('  Creating new account...');
					const newAccount = await api.post('/data/v1/accounts', {
						name: `${toProvider.name} Account`,
						displayName: `${toProvider.name} Account`,
						dataProviderType: toProvider.key,
						configurations: credentials
					});
					targetAccountId = newAccount.id || newAccount.accountId;
					callerUserId = callerUserId || newAccount.createdBy || newAccount.userId;
					createdAccountIds.push(targetAccountId);

					// Transfer ownership to the original account owner and remove our access
					if (ownerId && ownerId !== callerUserId) {
						console.log(`  Transferring account ${targetAccountId} ownership to user ${ownerId}...`);
						await api.put(`/data/v2/accounts/share/${targetAccountId}`, {
							type: 'USER',
							id: ownerId,
							accessLevel: 'OWNER'
						});
						await api.put(`/data/v2/accounts/share/${targetAccountId}`, {
							type: 'USER',
							id: callerUserId,
							accessLevel: 'NONE'
						});
					}

					if (ownerId) ownerToAccount[ownerId] = { id: targetAccountId };
					console.log(`  Created account: ${targetAccountId}`);
				}
			}

			// Strip read-only / stale fields
			delete stream.accounts;
			delete stream.accountTemplate;
			delete stream.schemaDefinition;
			delete stream.lastExecution;
			delete stream.lastSuccessfulExecution;
			delete stream.currentExecution;
			delete stream.currentExecutionState;
			delete stream.createdAt;
			delete stream.createdBy;
			delete stream.modifiedAt;
			delete stream.modifiedBy;
			delete stream.inactiveScheduleCode;

			// Set target transport
			stream.transport = targetTransport;

			// Set new provider (id and key only)
			stream.dataProvider = { id: toProvider.id, key: toProvider.key };

			// Set new account (id only)
			stream.account = { id: targetAccountId };

			if (stream.dataSource) {
				stream.dataSource.displayType = toProvider.key;
				stream.dataSource.dataProviderType = toProvider.key;
				stream.dataSource.type = toProvider.key;
				stream.dataSource.accountId = targetAccountId;
			}

			// Transform configuration if mapping exists
			if (configMapping && stream.configuration) {
				stream.configuration = transformConfiguration(stream.configuration, configMapping, stream.id);
				console.log(`  Mapped ${stream.configuration.length} configuration field(s)`);
			}

			if (dryRun) {
				console.log('  [DRY RUN] Would update stream');
			} else {
				await api.put(`/data/v1/streams/${stream.id}`, stream);

				// Update datasource provider properties directly (stream PUT doesn't propagate these)
				if (dataSourceId) {
					await api.put(`/data/v3/datasources/${dataSourceId}/providers/${toProvider.key}`);
				}

				console.log(`  Updated: ${instanceUrl}/datasources/${dataSourceId}/details/overview`);
			}
			successCount++;
		} catch (err) {
			console.error(`  Error: ${err.message}`);
			errorCount++;
		}

		if (i < streamEntries.length - 1) {
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	// Summary
	console.log('\n=== Summary ===');
	console.log(`Total streams: ${streamEntries.length}`);
	console.log(`Successful: ${successCount}`);
	console.log(`Errors: ${errorCount}`);
	if (createdAccountIds.length) console.log(`New accounts created: ${createdAccountIds.join(', ')}`);
	if (dryRun) console.log('(DRY RUN — no changes were made)');
	if (errorCount > 0) process.exitCode = 1;
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
