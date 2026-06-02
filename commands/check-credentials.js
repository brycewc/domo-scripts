/**
 * Check the validity of the configured Domo API credentials.
 *
 * Calls GET /dataprocessing/v1/dataflows/timezones — a lightweight,
 * read-only endpoint — to confirm DOMO_INSTANCE + DOMO_ACCESS_TOKEN are
 * valid for the selected instance. Exits 0 on success, 1 on failure.
 *
 * Usage:
 *   node cli.js check-credentials
 *   node cli.js check-credentials --env prod
 */

const config = require('../lib/config');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js check-credentials [options]

Validates the configured API credentials by calling
GET /dataprocessing/v1/dataflows/timezones against the selected instance.

Options:
  --env <name>   Load .env.<name> (handled by cli.js)
  --help, -h     Show this help`;

async function main() {
	showHelp(argv, HELP_TEXT);

	console.log('Check API Credentials');
	console.log('=====================\n');
	console.log(`Instance: ${config.instance} (${config.instanceUrl})`);
	if (config.env) console.log(`Env:      ${config.env}`);
	console.log('');

	config.requireAuth();

	const response = await fetch(
		`${config.baseUrl}/dataprocessing/v1/dataflows/timezones`,
		{
			method: 'GET',
			headers: {
				'X-DOMO-Developer-Token': config.accessToken,
				Accept: 'application/json'
			}
		}
	);

	console.log(`Response code: ${response.status} ${response.statusText}`);

	// A 2xx status alone is NOT proof of valid credentials: some Domo hosts
	// (e.g. placeholder/parked instances) answer every request with an empty
	// 200. We require the response to actually be the authenticated payload —
	// a non-empty JSON array of timezones.
	const body = await response.text();
	let timezones = null;
	try {
		timezones = body ? JSON.parse(body) : null;
	} catch (_) {
		// non-JSON body — treated as invalid below
	}
	const looksValid = Array.isArray(timezones) && timezones.length > 0;

	if (response.ok && looksValid) {
		console.log(`✓ Credentials are valid (received ${timezones.length} timezones)`);
	} else {
		console.error('✗ Credentials check failed');
		if (!response.ok) {
			console.error(`  HTTP ${response.status}: ${body.slice(0, 300) || '(empty body)'}`);
		} else {
			console.error(
				`  Status was ${response.status} but the response was not a valid timezone list ` +
					`(got ${body.length} bytes). This instance is not returning authenticated data — ` +
					`the credentials or instance host are likely wrong.`
			);
		}
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Error:', err.message || err);
	process.exit(1);
});
