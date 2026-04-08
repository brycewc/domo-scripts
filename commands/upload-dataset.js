/**
 * Upload a CSV file to a Domo DataSet in batches
 *
 * Usage:
 *   node cli.js upload-dataset --file "/path/to/file.csv" --dataset-id "00000000-0000-0000-0000-000000000000"
 *   node cli.js upload-dataset --file "/path/to/file.csv" --dataset-id "00000000-0000-0000-0000-000000000000" --batch-size 50000
 *   node cli.js upload-dataset --file "/path/to/file.csv" --dataset-id "00000000-0000-0000-0000-000000000000" --action APPEND
 *
 * Options:
 *   --file, -f        Path to the CSV file to upload (required)
 *   --dataset-id, -d  DataSet ID to upload to (required)
 *   --batch-size, -b  Number of rows per upload part (default: 10000)
 *   --action, -a    REPLACE or APPEND (default: REPLACE)
 */

const { baseUrl, accessToken, requireAuth } = require('../lib/config');
const fs = require('fs');
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

requireAuth();

const jsonHeaders = {
	'X-DOMO-Developer-Token': accessToken,
	Accept: 'application/json',
	'Content-Type': 'application/json'
};

async function createUpload(datasetId, action = 'REPLACE') {
	const url = `${baseUrl}/data/v3/datasources/${datasetId}/uploads`;
	const response = await fetch(url, {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({
			action,
			appendId: 'latest',
			message: "Beginning upload by uploadDataset command"
		})
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Failed to create upload: HTTP ${response.status}: ${errorText}`
		);
	}

	const result = await response.json();
	return result.uploadId;
}

async function uploadPart(datasetId, uploadId, partNumber, csvData) {
	const url = `${baseUrl}/data/v3/datasources/${datasetId}/uploads/${uploadId}/parts/${partNumber}`;
	const response = await fetch(url, {
		method: 'PUT',
		headers: {
			'X-DOMO-Developer-Token': accessToken,
			'Content-Type': 'text/csv'
		},
		body: csvData
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Failed to upload part ${partNumber}: HTTP ${response.status}: ${errorText}`
		);
	}

	return response.json().catch(() => ({}));
}

async function commitUpload(datasetId, uploadId, action) {
	const url = `${baseUrl}/data/v3/datasources/${datasetId}/uploads/${uploadId}/commit`;
	const response = await fetch(url, {
		method: 'PUT',
		headers: jsonHeaders,
		body: JSON.stringify({
			action,
			index: 'false',
			appendId: 'latest',
			message: "Committing upload by uploadDataset command"
		})
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Failed to commit upload: HTTP ${response.status}: ${errorText}`
		);
	}

	return response.json().catch(() => ({}));
}

async function indexDataset(datasetId, action) {
	const url = `${baseUrl}/data/v3/datasources/${datasetId}/indexes`;
	const response = await fetch(url, {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ action, index: 'true', appendId: 'latest' })
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Failed to start indexing: HTTP ${response.status}: ${errorText}`
		);
	}

	const result = await response.json();
	return result.requestKey;
}

async function pollIndexStatus(datasetId, requestKey) {
	const url = `${baseUrl}/data/v3/datasources/${datasetId}/indexes/${requestKey}/statuses`;
	const processingStates = ['PENDING', 'PROCESSING'];

	await new Promise((r) => setTimeout(r, 1000));

	while (true) {
		const response = await fetch(url, {
			method: 'GET',
			headers: {
				'X-DOMO-Developer-Token': accessToken,
				Accept: 'application/json'
			}
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Failed to check index status: HTTP ${response.status}: ${errorText}`
			);
		}

		const result = await response.json();
		const status = result.progress?.status || result.status;
		console.log(`  Index status: ${status}`);

		if (!processingStates.includes(status)) {
			if (status === 'SUCCESS') return result;
			throw new Error(`Indexing failed with status: ${status}`);
		}

		await new Promise((r) => setTimeout(r, 2000));
	}
}

async function main() {
	const filePath = argv.file || argv.f;
	const datasetId = argv['dataset-id'] || argv.d;
	const batchSize = parseInt(argv['batch-size'] || argv.b || '10000', 10);
	const action = (argv.action || argv.a || 'REPLACE').toUpperCase();

	if (argv.help || argv.h) {
		console.log('Usage:');
		console.log(
			'  node cli.js upload-dataset --file "data.csv" --dataset-id "<id>"'
		);
		console.log(
			'  node cli.js upload-dataset --file "data.csv" --dataset-id "<id>" --batch-size 50000'
		);
		console.log(
			'  node cli.js upload-dataset --file "data.csv" --dataset-id "<id>" --action APPEND'
		);
		console.log('\nOptions:');
		console.log('  --file, -f        Path to the CSV file to upload (required)');
		console.log('  --dataset-id, -d  DataSet ID to upload to (required)');
		console.log('  --batch-size, -b  Number of rows per upload part (default: 10000)');
		console.log('  --action, -a    REPLACE or APPEND (default: REPLACE)');
		process.exit(0);
	}

	if (!filePath) {
		console.error('Error: --file parameter is required');
		console.error('\nUsage:');
		console.error(
			'  node cli.js upload-dataset --file "data.csv" --dataset-id "<id>"'
		);
		console.error(
			'  node cli.js upload-dataset --file "data.csv" --dataset-id "<id>" --batch-size 50000'
		);
		console.error(
			'  node cli.js upload-dataset --file "data.csv" --dataset-id "<id>" --action APPEND'
		);
		process.exit(1);
	}

	if (!datasetId) {
		console.error('Error: --dataset-id parameter is required');
		process.exit(1);
	}

	if (!['REPLACE', 'APPEND'].includes(action)) {
		console.error('Error: --action must be REPLACE or APPEND');
		process.exit(1);
	}

	if (!fs.existsSync(filePath)) {
		console.error(`Error: File not found: ${filePath}`);
		process.exit(1);
	}

	const fileSizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(2);

	console.log('Upload CSV to DataSet');
	console.log('=====================\n');
	console.log(`File:       ${filePath} (${fileSizeMB} MB)`);
	console.log(`DataSet ID: ${datasetId}`);
	console.log(`Batch Size: ${batchSize} rows`);
	console.log(`Action:     ${action}\n`);

	const started = Date.now();

	try {
		console.log('Creating upload session...');
		const uploadId = await createUpload(datasetId, action);
		console.log(`  Upload ID: ${uploadId}\n`);

		let headerRow = null;
		let batchRows = [];
		let partNumber = 0;
		let totalRows = 0;
		let successCount = 0;
		let pendingRow = '';
		let inQuotes = false;

		const rl = readline.createInterface({
			input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
			crlfDelay: Infinity
		});

		async function flushBatch() {
			if (batchRows.length === 0) return;
			partNumber++;
			const csvPart = headerRow + '\n' + batchRows.join('\n');
			console.log(
				`Uploading part ${partNumber} (rows ${totalRows - batchRows.length + 1}-${totalRows})...`
			);
			await uploadPart(datasetId, uploadId, partNumber, csvPart);
			console.log(`  Part ${partNumber} uploaded successfully`);
			successCount++;
			batchRows = [];
			await new Promise((r) => setTimeout(r, 150));
		}

		for await (const rawLine of rl) {
			pendingRow += (pendingRow ? '\n' : '') + rawLine;

			const quoteCount = (rawLine.match(/"/g) || []).length;
			if (quoteCount % 2 !== 0) inQuotes = !inQuotes;
			if (inQuotes) continue;

			const completedRow = pendingRow;
			pendingRow = '';

			if (headerRow === null) {
				headerRow = completedRow;
				continue;
			}

			batchRows.push(completedRow);
			totalRows++;

			if (batchRows.length >= batchSize) {
				await flushBatch();
			}
		}

		if (pendingRow) {
			batchRows.push(pendingRow);
			totalRows++;
		}
		await flushBatch();

		if (totalRows === 0) {
			console.error(
				'Error: CSV file must contain a header row and at least one data row'
			);
			process.exit(1);
		}

		console.log('\nCommitting upload...');
		await commitUpload(datasetId, uploadId, action);
		console.log('  Commit successful');

		console.log('\nIndexing dataset...');
		const requestKey = await indexDataset(datasetId, action);
		await pollIndexStatus(datasetId, requestKey);
		console.log('  Indexing complete');

		const duration = ((Date.now() - started) / 1000).toFixed(2);
		console.log('\n=== Summary ===');
		console.log(`Rows uploaded:     ${totalRows}`);
		console.log(`Parts uploaded:    ${successCount}/${partNumber}`);
		console.log(`Action:            ${action}`);
		console.log(`Duration:          ${duration}s`);
		console.log('\nUpload completed successfully!');
	} catch (error) {
		console.error(`\nError: ${error.message}`);
		process.exit(1);
	}
}

main();
