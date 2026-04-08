require('dotenv').config({ path: __dirname + '/../.env' });

const instance = process.env.DOMO_INSTANCE || 'domo';
const instanceUrl = `https://${instance}.domo.com`;
const baseUrl = `${instanceUrl}/api`;
const accessToken = process.env.DOMO_ACCESS_TOKEN;

function requireAuth() {
	if (!accessToken) {
		console.error(
			'Error: DOMO_ACCESS_TOKEN is not set. Copy .env.example to .env and fill in your values.'
		);
		process.exit(1);
	}
}

module.exports = { instance, instanceUrl, baseUrl, accessToken, requireAuth };
