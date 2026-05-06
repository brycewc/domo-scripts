const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const envName = process.env.DOMO_ENV;

if (envName) {
	const envFile = path.join(projectRoot, `.env.${envName}`);
	if (!fs.existsSync(envFile)) {
		console.error(
			`Error: --env "${envName}" was specified but ${envFile} does not exist.`
		);
		process.exit(1);
	}
	require('dotenv').config({ path: envFile });
}

require('dotenv').config({ path: path.join(projectRoot, '.env') });

const instance = process.env.DOMO_INSTANCE || 'domo';
const instanceUrl = `https://${instance}.domo.com`;
const baseUrl = `${instanceUrl}/api`;
const accessToken = process.env.DOMO_ACCESS_TOKEN;
const env = envName || null;

function requireAuth() {
	if (!accessToken) {
		const hint = envName
			? `Check that .env.${envName} defines DOMO_ACCESS_TOKEN.`
			: 'Copy .env.example to .env and fill in your values, or pass --env <name> to load .env.<name>.';
		console.error(`Error: DOMO_ACCESS_TOKEN is not set. ${hint}`);
		process.exit(1);
	}
}

function loadEnvConfig(name) {
	if (!name) throw new Error('loadEnvConfig requires an env name');
	const envFile = path.join(projectRoot, `.env.${name}`);
	if (!fs.existsSync(envFile)) {
		console.error(`Error: env "${name}" specified but ${envFile} does not exist.`);
		process.exit(1);
	}
	const parsed = require('dotenv').parse(fs.readFileSync(envFile));
	const token = parsed.DOMO_ACCESS_TOKEN;
	if (!token) {
		console.error(`Error: DOMO_ACCESS_TOKEN missing in ${envFile}`);
		process.exit(1);
	}
	const inst = parsed.DOMO_INSTANCE || 'domo';
	const url = `https://${inst}.domo.com`;
	return {
		env: name,
		instance: inst,
		instanceUrl: url,
		baseUrl: `${url}/api`,
		accessToken: token
	};
}

module.exports = {
	instance,
	instanceUrl,
	baseUrl,
	accessToken,
	env,
	requireAuth,
	loadEnvConfig
};
