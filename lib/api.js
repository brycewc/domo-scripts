const config = require('./config');

function createApiClient({ baseUrl, accessToken, instance }) {
	if (!baseUrl) throw new Error('createApiClient: baseUrl is required');
	if (!accessToken) throw new Error('createApiClient: accessToken is required');

	const headers = {
		'X-DOMO-Developer-Token': accessToken,
		Accept: 'application/json',
		'Content-Type': 'application/json'
	};

	async function request(method, path, body) {
		const url = `${baseUrl}${path}`;
		const options = { method, headers };
		if (body !== undefined) options.body = JSON.stringify(body);

		const response = await fetch(url, options);
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`${method} ${path} failed: HTTP ${response.status}: ${errorText}`);
		}
		const text = await response.text();
		return text ? JSON.parse(text) : null;
	}

	return {
		instance,
		baseUrl,
		request,
		get: (p) => request('GET', p),
		put: (p, b) => request('PUT', p, b),
		post: (p, b) => request('POST', p, b),
		patch: (p, b) => request('PATCH', p, b),
		del: (p) => request('DELETE', p)
	};
}

let _default = null;
function getDefault() {
	if (!_default) {
		config.requireAuth();
		_default = createApiClient({
			baseUrl: config.baseUrl,
			accessToken: config.accessToken,
			instance: config.instance
		});
	}
	return _default;
}

module.exports = {
	createApiClient,
	request: (...args) => getDefault().request(...args),
	get: (p) => getDefault().get(p),
	put: (p, b) => getDefault().put(p, b),
	post: (p, b) => getDefault().post(p, b),
	patch: (p, b) => getDefault().patch(p, b),
	del: (p) => getDefault().del(p)
};
