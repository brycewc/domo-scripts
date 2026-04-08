const config = require('./config');

function getHeaders() {
	config.requireAuth();
	return {
		'X-DOMO-Developer-Token': config.accessToken,
		Accept: 'application/json',
		'Content-Type': 'application/json'
	};
}

async function request(method, path, body) {
	const url = `${config.baseUrl}${path}`;
	const defaultHeaders = getHeaders();
	const options = { method, headers: defaultHeaders };

	if (body !== undefined) {
		options.body = JSON.stringify(body);
	}

	const response = await fetch(url, options);

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`${method} ${path} failed: HTTP ${response.status}: ${errorText}`);
	}

	const text = await response.text();
	return text ? JSON.parse(text) : null;
}

const get = (path) => request('GET', path);
const put = (path, body) => request('PUT', path, body);
const post = (path, body) => request('POST', path, body);
const del = (path) => request('DELETE', path);

module.exports = { request, get, put, post, del };
