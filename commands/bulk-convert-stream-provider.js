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
 * prompted interactively. Credentials are never logged, so --from-dry-run and
 * --retry-errors need them again.
 *
 * --from-dry-run and --retry-errors skip the provider, connector and datasource
 * lookups but re-fetch each stream, skipping any that no longer use the source provider.
 *
 * Usage:
 *   node cli.js bulk-convert-stream-provider --from-connector "com.domo.connector.microsoft.sharepoint.online" --to-connector "com.domo.connector.microsoftsharepointonlinerest"
 *   node cli.js bulk-convert-stream-provider --from-connector "com.domo.connector.microsoft.sharepoint.online" --to-connector "com.domo.connector.microsoftsharepointonlinerest" --client_id "xxx" --client_secret "yyy"
 *   node cli.js bulk-convert-stream-provider --from-connector "com.domo.connector.microsoft.sharepoint.online" --to-connector "com.domo.connector.microsoftsharepointonlinerest" --dry-run
 *   node cli.js bulk-convert-stream-provider --from-connector "com.domo.connector.microsoft.sharepoint.online" --to-connector "com.domo.connector.microsoftsharepointonlinerest" --client_id "xxx" --client_secret "yyy" --stream-id 123
 *   node cli.js bulk-convert-stream-provider --from-dry-run --client_id "xxx" --client_secret "yyy"
 *   node cli.js bulk-convert-stream-provider --retry-errors --client_id "xxx" --client_secret "yyy"
 *
 * Options:
 *   --from-connector       Source connector ID (required)
 *   --to-connector         Target connector ID (required)
 *   --stream-id            Process a single stream instead of all streams for the source provider
 *   --dry-run              Preview changes without applying them (does not ask for credentials)
 *   --<credential>         Any required credential fields for the target provider (e.g. --client_id, --client_secret)
 *   --from-dry-run [file]  Run exactly what a dry run planned (default: the latest dry run log)
 *   --retry-errors [file]  Retry the failed and unreached items of a run (default: the latest run log)
 *   --max-age <hours>      Allow a source log older than 24 hours
 *   --yes, -y              Skip the confirmation prompt of --from-dry-run / --retry-errors
 */

const { api, config, providerMap, confirmSource, createLogger, loadSource, printSource, showHelp } = require('../lib');
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

const COMMAND = 'bulk-convert-stream-provider';
const SELECTION_FLAGS = ['from-connector', 'to-connector', 'stream-id', 'dry-run'];
const PAGE_SIZE = 50;

const HELP_TEXT = `Usage:
  node cli.js bulk-convert-stream-provider --from-connector <connectorId> --to-connector <connectorId> [...fields] [--dry-run]

Options:
  --from-connector       Source connector ID (required)
  --to-connector         Target connector ID (required)
  --stream-id            Process a single stream instead of all
  --dry-run              Preview changes without applying them (does not ask for credentials)
  --<credential>         Required credential fields for the target provider

Reusing an earlier run (skips discovery; the log's connectors are reused, credentials are not):
  --from-dry-run [file]  Run exactly what a dry run planned (default: the latest dry run log)
  --retry-errors [file]  Retry the failed and unreached items of a run (default: the latest run log)
  --max-age <hours>      Allow a source log older than 24 hours
  --yes, -y              Skip the confirmation prompt`;

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
	return providerMap[`${fromProviderKey}->${toProviderKey}`] || null;
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

// ── Setup ────────────────────────────────────────────────────────────

async function resolveProviders(fromConnector, toConnector) {
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

	return {
		fromConnector,
		toConnector,
		fromProvider: fromProvider.key,
		toProvider: toProvider.key,
		toProviderId: toProvider.id,
		toProviderName: toProvider.name,
		targetTransport: {
			type: 'CONNECTOR',
			description: toConnectorDef.id,
			version: `${toConnectorDef.version.major}.${toConnectorDef.version.minor}`
		},
		credentialFields: (toProvider.authenticationSchemeConfiguration || []).map((f) => ({
			name: f.name,
			text: f.text,
			tooltipText: f.tooltipText,
			required: Boolean(f.required)
		}))
	};
}

function providersFromMeta(source) {
	const meta = source.meta;
	const required = ['fromProvider', 'toProvider', 'toProviderId', 'toProviderName', 'targetTransport', 'credentialFields'];
	const missing = required.filter((k) => meta[k] == null);
	if (missing.length > 0) {
		console.error(`Error: ${source.relPath} does not record ${missing.join(', ')}. Re-run the dry run to create a new plan.`);
		process.exit(1);
	}
	console.log(`  From: ${meta.fromProvider} (connector ${meta.fromConnector})`);
	console.log(`  To:   ${meta.toProviderName} (${meta.toProvider}) via ${meta.targetTransport.description} v${meta.targetTransport.version}\n`);
	const { fromConnector, toConnector, fromProvider, toProvider, toProviderId, toProviderName, targetTransport, credentialFields } =
		meta;
	return { fromConnector, toConnector, fromProvider, toProvider, toProviderId, toProviderName, targetTransport, credentialFields };
}

// Dry runs never create accounts, so they only list the fields a real run asks for.
async function collectCredentials(credentialFields, dryRun) {
	const credentials = {};
	for (const field of credentialFields) {
		if (argv[field.name] !== undefined) {
			credentials[field.name] = String(argv[field.name]);
		}
	}

	const missingRequired = credentialFields.filter((f) => f.required && !credentials[f.name]);
	if (missingRequired.length === 0) return credentials;

	console.log(`Required credential fields for new accounts${dryRun ? ' (a real run will ask for these)' : ''}:`);
	for (const f of missingRequired) {
		const hint = f.tooltipText ? `: ${f.tooltipText}` : '';
		console.log(`  ${f.text || f.name} (--${f.name})${hint}`);
	}
	console.log('');
	if (dryRun) return credentials;

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
	return credentials;
}

async function findSourceStreams(fromProviderKey, singleStreamId) {
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
		return streamEntries;
	}

	console.log(`Fetching datasets for provider "${fromProviderKey}"...`);
	let offset = 0;
	while (true) {
		const result = await api.get(
			`/data/v3/datasources?dataProviderType=${fromProviderKey}&limit=${PAGE_SIZE}&offset=${offset}`
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
	return streamEntries;
}

// Owner of the stream's current account, falling back to the dataset owner when
// that user is deleted.
async function resolveAccountPlan(stream, toProviderKey, accountInfoCache) {
	const currentAccountId = stream.account?.id ?? null;
	let ownerId = null;
	let currentAccountIsTarget = false;
	if (currentAccountId) {
		if (!accountInfoCache[currentAccountId]) {
			accountInfoCache[currentAccountId] = await api.get(`/data/v1/accounts/${currentAccountId}`);
		}
		const currentAccount = accountInfoCache[currentAccountId];
		ownerId = currentAccount.userId;
		console.log(`  Current account: ${currentAccountId} (owner: ${ownerId})`);
		currentAccountIsTarget = currentAccount.dataProviderType === toProviderKey;
		if (currentAccountIsTarget) {
			console.log(`  Account already target provider type, reusing: ${currentAccountId}`);
		}
	} else {
		console.log('  No existing account on stream');
	}

	if (ownerId && !currentAccountIsTarget) {
		const ownerUser = await api.get(`/content/v2/users/${ownerId}`);
		if (!ownerUser.active) {
			const dsOwnerId = stream.dataSource?.owner?.id;
			console.log(`  Account owner ${ownerId} is deleted, falling back to dataset owner ${dsOwnerId}`);
			ownerId = dsOwnerId ? Number(dsOwnerId) : null;
		}
	}
	return { currentAccountId, ownerId, currentAccountIsTarget };
}

// The logged plan is reused only while the stream still points at the same account.
function recordedAccountPlan(entry, stream) {
	if (!('currentAccountId' in entry)) return null;
	if (String(entry.currentAccountId ?? '') !== String(stream.account?.id ?? '')) return null;
	if (entry.currentAccountId) {
		console.log(`  Current account: ${entry.currentAccountId} (owner: ${entry.ownerId ?? 'none'}, from log)`);
	}
	return {
		currentAccountId: entry.currentAccountId,
		ownerId: entry.ownerId ?? null,
		currentAccountIsTarget: Boolean(entry.currentAccountIsTarget)
	};
}

function toEntry(row) {
	if (row.streamId == null) return null;
	const entry = { streamId: row.streamId, dataSourceId: row.dataSourceId, dataSourceName: row.dataSourceName };
	for (const key of ['currentAccountId', 'ownerId', 'currentAccountIsTarget']) {
		if (key in row) entry[key] = row[key];
	}
	// A failed run may have created the owner's account or updated the stream before failing.
	if (row.status === 'error') {
		if (['create', 'reuse-created'].includes(row.accountAction) && row.targetAccountId) {
			entry.createdAccountId = row.targetAccountId;
			entry.accountShared = Boolean(row.accountShared);
			entry.callerUserId = row.callerUserId ?? null;
		}
		if (row.streamUpdated) entry.streamUpdated = true;
	}
	return entry;
}

async function transferAccountOwnership(accountId, ownerId, callerUserId) {
	console.log(`  Transferring account ${accountId} ownership to user ${ownerId}...`);
	await api.put(`/data/v2/accounts/share/${accountId}`, {
		type: 'USER',
		id: ownerId,
		accessLevel: 'OWNER'
	});
	await api.put(`/data/v2/accounts/share/${accountId}`, {
		type: 'USER',
		id: callerUserId,
		accessLevel: 'NONE'
	});
}

function stripReadOnlyFields(stream) {
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
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
	showHelp(argv, HELP_TEXT);

	const source = loadSource(COMMAND, argv, { selectionFlags: SELECTION_FLAGS, toEntries: toEntry });
	const dryRun = argv['dry-run'] || false;
	const singleStreamId = source ? null : argv['stream-id'];
	const debugMode = Boolean(singleStreamId);

	if (!source && (!argv['from-connector'] || !argv['to-connector'])) {
		console.error(
			'Usage: node cli.js bulk-convert-stream-provider --from-connector <connectorId> --to-connector <connectorId> [...fields] [--dry-run]'
		);
		process.exit(1);
	}

	// 1. Resolve providers and connector details (or reuse the logged ones)
	if (source) printSource(source);
	const providers = source
		? providersFromMeta(source)
		: await resolveProviders(argv['from-connector'], argv['to-connector']);
	const { fromProvider, toProvider, toProviderId, toProviderName, targetTransport } = providers;

	// 2. Load configuration mapping
	const configMapping = loadConfigMapping(fromProvider, toProvider);
	if (configMapping) {
		console.log(`Loaded config mapping: ${configMapping.description}\n`);
	} else {
		console.log(`No config mapping found for "${fromProvider}->${toProvider}" in providerMappings.json`);
		console.log('Stream configurations will be carried over as-is.\n');
	}

	// 3. Collect credential values (never logged)
	const credentials = await collectCredentials(providers.credentialFields, dryRun);

	// 4. Fetch all existing target-provider accounts, index by owner userId. Always
	// fresh: a retry must reuse accounts an earlier run already created.
	console.log(`Fetching existing "${toProvider}" accounts...`);
	const targetAccounts = await api.get(`/data/v1/accounts/provider/${toProvider}`);
	const ownerToAccount = {};
	for (const acc of targetAccounts) {
		if (!ownerToAccount[acc.userId]) {
			ownerToAccount[acc.userId] = acc;
		}
	}
	console.log(`  ${targetAccounts.length} account(s) across ${Object.keys(ownerToAccount).length} owner(s)\n`);

	// 5. Collect streams to process
	const streamEntries = source ? source.entries : await findSourceStreams(fromProvider, singleStreamId);
	console.log(`  ${source ? 'Planned' : 'Found'} ${streamEntries.length} stream(s) to process\n`);

	const logger = createLogger(COMMAND, { debugMode, dryRun, source, runMeta: providers });

	if (streamEntries.length === 0) {
		console.log(source ? 'The source log has nothing left to convert.' : 'Nothing to convert.');
		logger.writeRunLog({ total: 0, successful: 0, skipped: 0, errors: 0 });
		return;
	}

	if (source) {
		const confirmed = await confirmSource(
			`Convert ${streamEntries.length} stream(s) from ${fromProvider} to ${toProvider}? (y/N): `,
			argv
		);
		if (!confirmed) {
			console.log('Aborted. No changes were made.');
			process.exit(0);
		}
		console.log('');
	}

	logger.beginExecution(
		streamEntries.map(({ prefetched, ...entry }) => entry),
		(row) => String(row.streamId)
	);

	// 6. Process each stream
	let callerUserId = null;
	let successCount = 0;
	let skipCount = 0;
	let errorCount = 0;
	const accountInfoCache = {};
	const createdAccountIds = [];
	let plannedAccountCount = 0;

	for (let i = 0; i < streamEntries.length; i++) {
		const entry = streamEntries[i];
		const { streamId, prefetched } = entry;
		console.log(`[${i + 1}/${streamEntries.length}] Stream ${streamId}: ${entry.dataSourceName}`);

		let row = { streamId, dataSourceId: entry.dataSourceId, dataSourceName: entry.dataSourceName };
		let mutationAttempted = false;
		const record = (result) => {
			logger.addResult(result);
			if (debugMode) logger.writeDebugLog(streamId, result);
		};

		try {
			const stream = prefetched || (await api.get(`/data/v1/streams/${streamId}?fields=all`));
			row.dataSourceId = row.dataSourceId ?? stream.dataSource?.id;
			row.dataSourceName = row.dataSourceName ?? stream.dataSource?.name;

			if (entry.streamUpdated && stream.dataProvider?.key === toProvider) {
				console.log('  Stream already converted by the source run; finishing the dataset provider update');
				mutationAttempted = true;
				if (row.dataSourceId) {
					await api.put(`/data/v3/datasources/${row.dataSourceId}/providers/${toProvider}`);
				}
				record({ ...row, status: 'converted', resumed: true });
				successCount++;
				continue;
			}

			// Converting an already-converted stream would wipe its configuration.
			if (stream.dataProvider?.key !== fromProvider) {
				console.log(`  Skipped: stream provider is "${stream.dataProvider?.key}", not "${fromProvider}"`);
				record({ ...row, status: 'skipped', reason: 'provider-changed' });
				skipCount++;
				continue;
			}

			const plan =
				(source && recordedAccountPlan(entry, stream)) ||
				(await resolveAccountPlan(stream, toProvider, accountInfoCache));
			row = { ...row, ...plan };
			const { ownerId } = plan;

			// Determine target account: one per owner so ownership can be transferred
			let targetAccountId = null;
			let accountAction;
			if (plan.currentAccountIsTarget) {
				targetAccountId = plan.currentAccountId;
				accountAction = 'reuse-current';
			} else if (entry.createdAccountId) {
				targetAccountId = entry.createdAccountId;
				accountAction = 'reuse-created';
				console.log(`  Reusing account ${targetAccountId} created by the source run`);
				row = { ...row, targetAccountId, accountAction, callerUserId: entry.callerUserId };
				if (!entry.accountShared && ownerId && entry.callerUserId && ownerId !== entry.callerUserId) {
					mutationAttempted = true;
					await transferAccountOwnership(targetAccountId, ownerId, entry.callerUserId);
				}
				row.accountShared = true;
				if (ownerId && !ownerToAccount[ownerId]) ownerToAccount[ownerId] = { id: targetAccountId };
			} else if (ownerId && ownerToAccount[ownerId]) {
				targetAccountId = ownerToAccount[ownerId].id;
				accountAction = ownerToAccount[ownerId].planned ? 'reuse-planned' : 'reuse-owner';
				console.log(
					accountAction === 'reuse-planned'
						? `  [DRY RUN] Would reuse the account planned for owner ${ownerId}`
						: `  Owner already has target account: ${targetAccountId}`
				);
			} else if (dryRun) {
				accountAction = 'create';
				console.log(`  [DRY RUN] Would create new account${ownerId ? ` for owner ${ownerId}` : ''}`);
				plannedAccountCount++;
				if (ownerId) ownerToAccount[ownerId] = { id: null, planned: true };
			} else {
				accountAction = 'create';
				console.log('  Creating new account...');
				mutationAttempted = true;
				const newAccount = await api.post('/data/v1/accounts', {
					name: `${toProviderName} Account`,
					displayName: `${toProviderName} Account`,
					dataProviderType: toProvider,
					configurations: credentials
				});
				targetAccountId = newAccount.id || newAccount.accountId;
				callerUserId = callerUserId || newAccount.createdBy || newAccount.userId;
				createdAccountIds.push(targetAccountId);
				row = { ...row, targetAccountId, accountAction, callerUserId };

				// Transfer ownership to the original account owner and remove our access
				if (ownerId && ownerId !== callerUserId) {
					await transferAccountOwnership(targetAccountId, ownerId, callerUserId);
				}
				row.accountShared = true;

				if (ownerId) ownerToAccount[ownerId] = { id: targetAccountId };
				console.log(`  Created account: ${targetAccountId}`);
			}
			row = { ...row, targetAccountId, accountAction };

			stripReadOnlyFields(stream);
			stream.transport = targetTransport;
			stream.dataProvider = { id: toProviderId, key: toProvider };
			stream.account = { id: targetAccountId };

			if (stream.dataSource) {
				stream.dataSource.displayType = toProvider;
				stream.dataSource.dataProviderType = toProvider;
				stream.dataSource.type = toProvider;
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
				mutationAttempted = true;
				await api.put(`/data/v1/streams/${stream.id}`, stream);
				row.streamUpdated = true;

				// Update datasource provider properties directly (stream PUT doesn't propagate these)
				if (row.dataSourceId) {
					await api.put(`/data/v3/datasources/${row.dataSourceId}/providers/${toProvider}`);
				}

				console.log(`  Updated: ${config.instanceUrl}/datasources/${row.dataSourceId}/details/overview`);
			}
			record({ ...row, status: dryRun ? 'dry-run' : 'converted' });
			successCount++;
		} catch (err) {
			console.error(`  Error: ${err.message}`);
			// Source mode re-fetches as part of execution, so those failures stay retryable.
			const phase = !source && !mutationAttempted ? { phase: 'discover' } : {};
			record({ ...row, status: 'error', ...phase, error: err.message });
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
	if (skipCount > 0) console.log(`Skipped (provider changed): ${skipCount}`);
	console.log(`Errors: ${errorCount}`);
	if (createdAccountIds.length) console.log(`New accounts created: ${createdAccountIds.join(', ')}`);
	if (plannedAccountCount) console.log(`New accounts to create: ${plannedAccountCount}`);
	if (dryRun) console.log('(DRY RUN: no changes were made)');
	logger.writeRunLog({
		total: streamEntries.length,
		successful: successCount,
		skipped: skipCount,
		errors: errorCount,
		createdAccountIds
	});
	if (dryRun) {
		console.log(`Run "node cli.js ${COMMAND} --from-dry-run" to apply this plan.`);
	} else if (errorCount > 0) {
		console.error(`\nSome streams failed. Run "node cli.js ${COMMAND} --retry-errors" to retry them.`);
	}
	if (errorCount > 0) process.exitCode = 1;
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
