const config = require('./config');
const api = require('./api');
const { readCSV } = require('./csv');
const { resolveIds } = require('./input');
const { createLogger } = require('./log');
const { loadSource, printSource, confirmSource, stripStatus } = require('./plan');
const { showHelp } = require('./help');
const idMapping = require('./id-mapping');
const { rewriteDomain } = require('./rewrite');
const { partitionExistingDatasets } = require('./datasets');
const providerMap = require('./provider-mappings.json');

module.exports = {
	config,
	api,
	createApiClient: api.createApiClient,
	loadEnvConfig: config.loadEnvConfig,
	readCSV,
	resolveIds,
	createLogger,
	loadSource,
	printSource,
	confirmSource,
	stripStatus,
	showHelp,
	idMapping,
	rewriteDomain,
	partitionExistingDatasets,
	providerMap
};
