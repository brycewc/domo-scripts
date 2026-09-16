/**
 * Walk a dashboard and every subdashboard beneath it, exporting each page as a
 * PowerPoint deck, each card as a PDF, a PNG and its definition JSON, the
 * original file behind every doc/image card, every file embedded in a notebook
 * card, and every dataset the cards read from as Excel.
 *
 * Output mirrors the dashboard hierarchy: each page gets a folder, subpages nest
 * inside their parent, and datasets are deduplicated into a single folder at the
 * root of the export. A cards.xlsx index at the root ties the two together, one
 * row per card and dataset.
 *
 * Usage:
 *   node cli.js export-dashboard-content --page-id 2040411307
 *   node cli.js export-dashboard-content --dataapp-id 825362141 --output ./exports/my-app
 *   node cli.js export-dashboard-content --page-id 2040411307 --no-datasets --dry-run
 *
 * Options:
 *   --page-id            Root page (dashboard) ID to export
 *   --dataapp-id         App Studio app ID; exports every view in the app
 *   --output, -o         Output directory (default: exports/<name>_<date>)
 *   --dataset-format     xlsx or csv for dataset exports (default: xlsx)
 *   --scale              Render scale for card images/PDFs (default: 2)
 *   --width              Render width in px (default: 1920)
 *   --height             Render height in px (default: 1116)
 *   --locale             Locale passed to the renderer (default: en-US)
 *   --clear              Delete each page folder before writing into it
 *   --no-subpages        Only export the root page, not its subpages
 *   --no-card-pdf        Skip the per-card PDF
 *   --no-card-image      Skip the per-card PNG
 *   --no-card-json       Skip the per-card definition JSON
 *   --index-format       xlsx or csv for the card index (default: xlsx)
 *   --no-card-index      Skip the card-to-dataset index
 *   --no-page-ppt        Skip the whole-page PowerPoint deck
 *   --no-documents       Skip downloading doc/image card files and notebook attachments
 *   --no-datasets        Skip dataset exports
 *   --dry-run            List what would be exported without downloading
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const sanitize = require('sanitize-filename');
const XLSX = require('xlsx');
const { PDFDocument } = require('pdf-lib');
const api = require('../lib/api');
const config = require('../lib/config');
const { createLogger } = require('../lib/log');
const { showHelp } = require('../lib/help');
const argv = require('minimist')(process.argv.slice(2));

const HELP_TEXT = `Usage: node cli.js export-dashboard-content [options]

Walks a dashboard and all of its subdashboards. Each page is exported as a
PowerPoint deck. For every card it downloads a PDF render, a PNG render and the
card's definition as JSON; for doc/image cards it downloads the original file
instead, and it pulls down anything embedded in a notebook card. Every dataset
feeding those cards is exported as Excel.

Root (one of):
  --page-id <id>         Page (dashboard) ID to start from
  --dataapp-id <id>      App Studio app ID; exports every view in the app

Optional:
  --output, -o <dir>     Output directory
                         (default: exports/<name>_<date>, so a second run
                         on the same day overwrites it in place)
  --dataset-format <fmt> xlsx or csv for dataset exports (default: xlsx)
  --index-format <fmt>   xlsx or csv for the card index (default: xlsx)
  --scale <n>            Render scale for card PDFs/images (default: 2)
  --width <px>           Render width (default: 1920)
  --height <px>          Render height (default: 1116)
  --locale <locale>      Renderer locale (default: en-US)
  --clear                Delete each page folder before writing into it, so a
                         re-run leaves no files behind for cards that were
                         renamed or removed in Domo. Only page folders are
                         touched: datasets/, README.md and anything else in the
                         output directory survive
  --no-subpages          Only the root page, no recursion
  --no-card-pdf          Skip per-card PDFs
  --no-card-image        Skip per-card PNGs
  --no-card-json         Skip per-card definition JSON
  --no-card-index        Skip the card-to-dataset index at the export root
  --no-page-ppt          Skip whole-page PowerPoint decks
  --no-documents         Skip doc/image card files and notebook attachments
  --no-datasets          Skip dataset exports
  --dry-run              List what would be exported without downloading
  --help                 Show this help

Notes:
  - cards.xlsx at the export root maps every card to the dataset behind it and
    to the files exported for it. It is written even under --no-datasets, where
    the dataset name and id are still filled in and only the workbook column is
    blank.
  - The page deck is a legacy .ppt, produced by the same export the Domo UI
    uses. It covers chart cards only: the export silently drops doc and image
    cards, which are downloaded as their original files instead.
  - Doc and image cards are not rendered and get no definition JSON; their
    original uploaded file is downloaded instead, which is the card's actual
    content.
  - The card renderer answers HTTP 200 even when it draws nothing, whether the
    card has no data or the renderer fell back to a placeholder. Any set of
    distinct cards whose renders come out byte-identical is listed under
    "Suspect renders" at the end of the run.
  - Dataset exports are not row-capped. A dashboard sitting on large datasets
    can produce very large files and run for a long time.`;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_MIME = 'text/csv';
const FILE_CARD_TYPES = new Set(['document', 'image']);
const RENDER_TIMEOUT_MS = 180000;
const PPT_TIMEOUT_MS = 600000;
// 50 ids is roughly a 550 character URL, well inside any limit, and costs one
// request per page for all but the largest dashboards.
const CARD_DATASET_CHUNK = 50;

// Each card type keeps its definition behind a different endpoint, and each one
// 400s on the types it does not own. "Text" is Domo's internal name for a
// notebook card (CardTypes.isNotebook is an equality check against it).
const ANALYZER_CARD_TYPES = new Set(['kpi', 'drill_view']);
const NOTEBOOK_CARD_TYPES = new Set(['Text']);

// Fallback shape for the remaining types (poll, supertable, domoapp, sql, ...).
// Every non-deprecated member of CardComponentType that describes how the card
// is built; access-control parts (resourceAccess, permissionLevel, shareRecord)
// and placement parts (pages, collections) are left out, since they say where
// the card lives and who may see it, not what it is.
const CARD_PARTS = [
  'metadata',
  'metadataOverrides',
  'properties',
  'domoapp',
  'library',
  'certification',
  'problems',
  'owners',
  'subscriptions',
  'formulas',
  'cardFormulas',
  'conditionalFormats',
  'drillPath',
  'drillPathURNs',
  'drillParents',
  'extendedDateInfo'
].join(',');

function authHeaders(extra) {
  return { 'X-DOMO-Developer-Token': config.accessToken, ...extra };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeName(value, fallback) {
  const cleaned = sanitize(String(value ?? '').trim()).replace(/\s+/g, ' ');
  return cleaned || fallback;
}

/** Content-Disposition filenames come back form-encoded, so "+" means space. */
function filenameFromDisposition(disposition) {
  if (!disposition) return null;
  const match = /filename\*=(?:utf-8|UTF-8)''([^;]+)/.exec(disposition) || /filename="?([^";]+)"?/.exec(disposition);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' ')).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}

async function assertOk(response) {
  if (response.ok) return;
  const body = await response.text();
  const error = new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  error.status = response.status;
  throw error;
}

/** Streams to disk. Used for datasets and card files, which can be very large. */
async function download(url, options, destPath) {
  const response = await fetch(url, options);
  await assertOk(response);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destPath));
  return {
    bytes: fs.statSync(destPath).size,
    disposition: response.headers.get('content-disposition')
  };
}

/**
 * Buffers instead of streaming so the payload can be fingerprinted. Renders are
 * small, and the digest is what lets identical placeholder renders be spotted.
 */
async function downloadRender(url, options, destPath) {
  const response = await fetch(url, options);
  await assertOk(response);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, bytes);
  return { bytes: bytes.length, digest: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/**
 * renderLogicalPixels is not optional: without it the renderer treats width and
 * height as device pixels and divides them by scale, so a 1920x1116 request is
 * drawn in a 960x558 viewport and the chart comes back with its axis and
 * category labels dropped for lack of room.
 */
function renderBody(renderOpts) {
  return JSON.stringify({
    width: renderOpts.width,
    height: renderOpts.height,
    scale: renderOpts.scale,
    renderLogicalPixels: true,
    darkMode: false,
    locale: renderOpts.locale
  });
}

async function renderCardPng(cardId, renderOpts) {
  const url = `${config.baseUrl}/davinci/v1/image/png/${cardId}` + `?locale=${encodeURIComponent(renderOpts.locale)}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: renderBody(renderOpts),
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS)
  });
  await assertOk(response);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The card PDF is built here rather than taken from the renderer's own PDF
 * endpoint. That endpoint always emits two pages, the first with an empty
 * content stream and the chart stranded on the second, and it embeds the chart
 * as a raster image anyway, so wrapping the PNG loses no fidelity and gains a
 * single correctly sized page for one render instead of two.
 */
async function pngToPdf(pngBytes) {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(pngBytes);
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return Buffer.from(await doc.save());
}

function writeRender(bytes, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, bytes);
  return { bytes: bytes.length };
}

/**
 * The page deck goes through the same synchronous export the UI uses rather than
 * /api/content/v1/export/v4/pages/{id}/layouts/{pdf,ppt}/sync, because that one
 * requires a v4 page layout and rejects classic card-grid pages outright.
 */
async function exportPagePpt(title, cardIds, destPath) {
  const payload = {
    filename: title,
    kpiList: cardIds.map(String),
    filters: [],
    beacon: '',
    filterGroupIds: [],
    overrideSlicers: false,
    showAnnotations: false,
    phoenix: true
  };
  const result = await downloadRender(
    `${config.instanceUrl}/presentations`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: `exportdata=${encodeURIComponent(JSON.stringify(payload))}`,
      signal: AbortSignal.timeout(PPT_TIMEOUT_MS)
    },
    destPath
  );

  // The endpoint answers 200 with an HTML error page when it fails, so confirm
  // the OLE2 compound-file magic before calling this a successful export.
  const header = Buffer.alloc(8);
  const handle = fs.openSync(destPath, 'r');
  try {
    fs.readSync(handle, header, 0, 8, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (header.toString('hex') !== 'd0cf11e0a1b11ae1') {
    fs.unlinkSync(destPath);
    throw new Error('Response was not a PowerPoint file');
  }
  return result;
}

/** Doc cards hand back a real array here; notebook cards a JSON-encoded string. */
function parseDataFileIds(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Doc/image cards reference their upload either as metadata.dataFileIds (newer
 * cards) or as metadata.documentId in "<fileId>:<revisionId>" form, where the
 * revision half is often the literal string "undefined" and the real revision
 * lives in metadata.revisionId. Notebook cards list their embedded images and
 * attachments in dataFileIds as well.
 */
function dataFileRefs(card) {
  const metadata = card.metadata || {};
  const fileIds = parseDataFileIds(metadata.dataFileIds);
  if (fileIds.length > 0) {
    return fileIds.map((id) => ({ fileId: String(id), revisionId: null }));
  }
  if (!metadata.documentId) return [];
  const [fileId, revisionPart] = String(metadata.documentId).split(':');
  if (!fileId) return [];
  const revisionId = revisionPart && revisionPart !== 'undefined' ? revisionPart : metadata.revisionId ? String(metadata.revisionId) : null;
  return [{ fileId, revisionId }];
}

async function downloadCardFile(ref, cardTitle, destDir, prefix) {
  const filePath = ref.revisionId ? `/data/v1/data-files/${ref.fileId}/revisions/${ref.revisionId}` : `/data/v1/data-files/${ref.fileId}`;

  let details = null;
  try {
    details = await api.get(`/data/v1/data-files/${ref.fileId}/details`);
  } catch {
    // Details are a nicety; the download's Content-Disposition is the fallback.
  }
  const name = details && details.name;

  const tempPath = path.join(destDir, `${prefix}_${ref.fileId}.download`);
  let result;
  try {
    result = await download(`${config.baseUrl}${filePath}`, { headers: authHeaders() }, tempPath);
  } catch (error) {
    // The file endpoint maps a missing blob to 400 "Forbidden", which reads as
    // a permission problem. A record with no current revision has simply lost
    // its content, so say that instead of repeating the misleading status.
    if (details && !details.currentRevision && !ref.revisionId) {
      throw new Error(`file content no longer stored in Domo (data file ${ref.fileId}${name ? `, "${name}"` : ''})`);
    }
    throw error;
  }

  const resolved = name || filenameFromDisposition(result.disposition) || `${cardTitle}.bin`;
  const finalPath = path.join(destDir, `${prefix}_${safeName(resolved, `file_${ref.fileId}`)}`);
  fs.renameSync(tempPath, finalPath);
  return { path: finalPath, bytes: result.bytes };
}

/**
 * For a chart card, the Analyzer definition: chart type and every chart
 * override, the query each component runs (columns, aggregations, filters, date
 * range and grain, sorting), slicer controls, segments, conditional formats,
 * beast mode formulas, drill path, and the dataset's column schema.
 *
 * For a notebook card, its content: the rich-text markup, the rendered HTML,
 * and any dynamic text bound to a dataset.
 */
async function exportCardDefinition(card, destPath) {
  let definition;
  if (ANALYZER_CARD_TYPES.has(card.type)) {
    definition = await api.put('/content/v3/cards/kpi/definition', {
      dynamicText: true,
      variables: true,
      urn: String(card.id)
    });
  } else if (NOTEBOOK_CARD_TYPES.has(card.type)) {
    // No parts param: the endpoint defaults to NotebookPart.all.
    definition = await api.get(`/content/v1/cards/notebook/${encodeURIComponent(card.id)}`);
  } else {
    const result = await api.get(`/content/v1/cards?urns=${encodeURIComponent(card.id)}&parts=${CARD_PARTS}`);
    definition = Array.isArray(result) ? result[0] : result;
  }
  if (!definition) throw new Error('card definition not returned');
  return writeRender(Buffer.from(`${JSON.stringify(definition, null, 2)}\n`), destPath);
}

/**
 * Card to dataset, in bulk. The `datasources` part is the only shape that answers
 * this per card: it is already deduplicated, carries the dataset name, and covers
 * notebook cards bound to a dataset, not just charts. The Analyzer definition
 * written next to each card has no dataset id on its subscriptions at all.
 */
async function fetchCardDatasets(cardIds) {
  const byCard = new Map();
  for (let i = 0; i < cardIds.length; i += CARD_DATASET_CHUNK) {
    const chunk = cardIds.slice(i, i + CARD_DATASET_CHUNK);
    const cards = await api.get(`/content/v1/cards?parts=datasources&urns=${chunk.join(',')}`);
    for (const card of cards || []) byCard.set(String(card.id), card.datasources || []);
  }
  return byCard;
}

async function exportDataset(dataset, destDir, format) {
  const mime = format === 'csv' ? CSV_MIME : XLSX_MIME;
  const extension = format === 'csv' ? 'csv' : 'xlsx';
  const fileName = `${safeName(dataset.name, 'dataset')}_${dataset.id}.${extension}`;
  const destPath = path.join(destDir, fileName);
  const url = `${config.baseUrl}/query/v1/execute/export/${dataset.id}` + `?accept=${encodeURIComponent(mime)}&includeHeader=true&fileName=${encodeURIComponent(fileName)}`;
  const result = await download(url, { headers: authHeaders() }, destPath);
  return { path: destPath, bytes: result.bytes };
}

async function getPageTree(pageId, includeSubpages, seen) {
  if (seen.has(String(pageId))) return null;
  seen.add(String(pageId));

  const page = await api.get(`/content/v1/pages/${pageId}`);
  const node = {
    id: String(pageId),
    title: page.title || `Page ${pageId}`,
    children: []
  };

  if (!includeSubpages) return node;

  let childIds = [];
  try {
    childIds = (await api.get(`/content/v1/pages/${pageId}/subpages`)) || [];
  } catch {
    childIds = [];
  }

  for (const childId of childIds) {
    const child = await getPageTree(childId, includeSubpages, seen);
    if (child) node.children.push(child);
  }
  return node;
}

async function getDataAppTree(dataAppId, includeSubpages, seen) {
  const app = await api.get(`/content/v1/dataapps/${dataAppId}`);
  const root = {
    id: null,
    title: app.title || `App ${dataAppId}`,
    children: []
  };

  async function fromView(view) {
    const node = await getPageTree(view.viewId, false, seen);
    if (!node) return null;
    node.title = view.title || node.title;
    if (includeSubpages) {
      for (const child of view.children || []) {
        const childNode = await fromView(child);
        if (childNode) node.children.push(childNode);
      }
    }
    return node;
  }

  for (const view of app.views || []) {
    const node = await fromView(view);
    if (node) root.children.push(node);
  }
  return root;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Local calendar date, so "same day" means the operator's day, not UTC's. */
function localDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Local wall-clock time plus the UTC instant, so the two can never be confused. */
function formatExportedAt(date) {
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(date).find((part) => part.type === 'timeZoneName');
  return `${localDate(date)} ${time}${zone ? ` ${zone.value}` : ''} (${date.toISOString()})`;
}

/** Quotes an argv entry so the reproduce command survives copy-paste into a shell. */
function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function describeError(entry) {
  const target = entry.cardId ? `card ${entry.cardId}` : entry.datasetId ? `dataset ${entry.datasetId}` : entry.pageId ? `page ${entry.pageId}` : 'export';
  const where = entry.cardId && entry.pageId ? `${target} on page ${entry.pageId}` : target;
  return `[${entry.at}] ${entry.kind} | ${where} | ${entry.error}`;
}

/** Page and card names carry spaces and parentheses, which a bare link target cannot. */
function fileLink(label, relativePath) {
  const target = relativePath.split(path.sep).join('/').split('/').map(encodeURIComponent).join('/');
  return `[${label}](<${target}>)`;
}

// Column order shared by both index formats. LINK_COLS are the 0-based indexes
// turned into clickable hyperlinks in xlsx output.
const INDEX_HEADER = [
  'Page',
  'Page ID',
  'Page Folder',
  'Card',
  'Card ID',
  'Card Type',
  'Card Files',
  'Dataset',
  'Dataset ID',
  'Dataset Type',
  'Dataset File',
  'Card Link',
  'Dataset Link'
];
const INDEX_LINK_COLS = [11, 12];

function csvField(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(fields) {
  return fields.map(csvField).join(',') + '\n';
}

function writeCardIndex(destPath, rows, format) {
  if (format === 'csv') {
    fs.writeFileSync(destPath, rows.reduce((out, row) => out + csvRow(row), csvRow(INDEX_HEADER)));
    return { bytes: fs.statSync(destPath).size };
  }
  const sheet = XLSX.utils.aoa_to_sheet([INDEX_HEADER, ...rows]);
  for (let i = 0; i < rows.length; i++) {
    for (const col of INDEX_LINK_COLS) {
      const url = rows[i][col];
      if (!url) continue;
      const ref = XLSX.utils.encode_cell({ c: col, r: i + 1 });
      if (sheet[ref]) sheet[ref].l = { Target: url, Tooltip: url };
    }
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Cards');
  XLSX.writeFile(book, destPath);
  return { bytes: fs.statSync(destPath).size };
}

function buildErrorLog(errors, context) {
  const lines = [
    `Export errors: ${context.rootTitle}`,
    `Instance: ${context.instance}.domo.com`,
    `Run: ${context.startedAt}`,
    `Failures: ${errors.length}`,
    '',
    'Each line is: [time] what-failed | which object | why.',
    'Everything not listed here exported successfully.',
    ''
  ];
  for (const entry of errors) lines.push(describeError(entry));
  lines.push('');
  return lines.join('\n');
}

function buildReadme(context) {
  const { rootTitle, rootId, isDataApp, instance, startedAt, durationMs, pageReports, datasets, counts, totalCards, totalBytes, suspect, errors, datasetFormat, renderOpts, commandLine, clearPages, cardIndex } = context;

  const rootUrl = isDataApp ? `https://${instance}.domo.com/app-studio/${rootId}` : `https://${instance}.domo.com/page/${rootId}`;

  const lines = [];
  lines.push(`# ${rootTitle}`);
  lines.push('');
  lines.push(`Export of a Domo dashboard and everything beneath it.`);
  lines.push('');
  lines.push(`- **Exported:** ${startedAt} (took ${formatDuration(durationMs)})`);
  lines.push(
    clearPages
      ? '- **Re-running on the same day** overwrites this folder in place. This run used `--clear`, so each page folder was deleted first and everything under the page folders below came from this run alone.'
      : '- **Re-running on the same day** overwrites this folder in place. Files from an earlier run that day survive only if nothing replaced them, so a card renamed or removed in Domo can leave a stale file behind. Pass `--clear` to delete each page folder before writing into it.'
  );
  lines.push(`- **Instance:** \`${instance}.domo.com\``);
  lines.push(`- **Source:** ${isDataApp ? 'App Studio app' : 'Page'} \`${rootId}\`, <${rootUrl}>`);
  lines.push(`- **Size on disk:** ${formatBytes(totalBytes)}`);
  lines.push('');
  lines.push('## Contents');
  lines.push('');
  lines.push('| What | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| Pages | ${pageReports.length} |`);
  lines.push(`| Cards across all pages | ${totalCards} |`);
  for (const [label, value] of [
    ['Page decks (.ppt)', counts.pagePpt],
    ['Card PDFs', counts.cardPdf],
    ['Card images (.png)', counts.cardImage],
    ['Card definitions (.json)', counts.cardJson],
    ['Original files from doc, image and notebook cards', counts.cardFile],
    ['DataSets', counts.datasets]
  ]) {
    if (value > 0) lines.push(`| ${label} | ${value} |`);
  }
  lines.push('');

  lines.push('## Pages');
  lines.push('');
  for (const page of pageReports) {
    const indent = '  '.repeat(page.depth);
    const types = Object.entries(page.types)
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => `${n} ${type}`)
      .join(', ');
    const deck = page.deck
      ? `. ${fileLink('Deck', `${page.dir}/${page.deck.file}`)} has ${page.deck.cards} card${page.deck.cards === 1 ? '' : 's'}${page.deck.excluded ? `, ${page.deck.excluded} file card(s) excluded` : ''}`
      : '';
    lines.push(`${indent}- **${page.title}** (\`${page.id}\`): ${page.cardCount} card${page.cardCount === 1 ? '' : 's'}${types ? ` (${types})` : ''}${deck}`);
    const folder = page.dir ? `${fileLink(`${page.dir}/`, page.dir)}` : '`.`';
    const cardsLink = page.cardsDir ? ` · ${fileLink('cards', page.cardsDir)}` : '';
    lines.push(`${indent}  ${folder}${cardsLink} · <https://${instance}.domo.com/page/${page.id}>`);
  }
  lines.push('');

  if (datasets.length > 0) {
    lines.push('## Datasets');
    lines.push('');
    lines.push('One workbook per dataset, deduplicated across every page above.');
    lines.push('');
    lines.push('| Dataset | ID | File |');
    lines.push('| --- | --- | --- |');
    for (const dataset of datasets) {
      const file = dataset.file ? `${fileLink(`datasets/${dataset.file}`, `datasets/${dataset.file}`)} (${formatBytes(dataset.bytes)})` : '_not exported_';
      lines.push(`| ${dataset.name} | \`${dataset.id}\` | ${file} |`);
    }
    lines.push('');
  }

  lines.push('## Folder layout');
  lines.push('');
  lines.push('```');
  lines.push('<page title>/');
  if (counts.pagePpt > 0) {
    lines.push("  _page_<page title>.ppt   PowerPoint deck of that page's chart cards");
  }
  if (counts.cardPdf > 0 || counts.cardImage > 0 || counts.cardJson > 0 || counts.cardFile > 0) {
    lines.push('  cards/');
    if (counts.cardPdf > 0) lines.push('    NN_<card title>.pdf    one-page PDF render of the card');
    if (counts.cardImage > 0) lines.push('    NN_<card title>.png    PNG render of the card');
    if (counts.cardJson > 0) lines.push('    NN_<card title>.json   how the card is defined in Domo');
    if (counts.cardFile > 0) {
      lines.push('    NN_<file name>.<ext>   original upload, for doc, image and notebook cards');
    }
  }
  if (pageReports.some((page) => page.depth > 0)) {
    lines.push('  <subpage title>/         subpages nest inside their parent');
  }
  if (counts.datasets > 0) lines.push('datasets/                  one workbook per dataset');
  if (cardIndex) lines.push(`${`${cardIndex.file}`.padEnd(26)} every card, and the dataset behind it`);
  lines.push('README.md                  this file');
  if (errors.length > 0) lines.push('errors.txt                 what failed, and why');
  lines.push('```');
  lines.push('');
  lines.push('The `NN_` prefix on card files is the order the card appears on its page, so the files sort the way the page reads.');
  lines.push('');

  lines.push('## Using these files');
  lines.push('');
  if (cardIndex) {
    lines.push(
      `- **${fileLink(cardIndex.file, cardIndex.file)}** is the index tying the two halves of this export together. One row per card, and a row per dataset for cards that read more than one, with the card's exported files and the workbook its data came from. Sort or filter it to answer which cards read a given dataset, or which dataset is behind a given number. Cards with no dataset, meaning doc, image and most notebook cards, are listed with the dataset columns blank, so the file is also a full inventory of what was exported.`
    );
  }
  if (counts.cardPdf > 0 || counts.cardImage > 0) {
    lines.push(
      `- **Card PDFs and PNGs** are pictures of each card as it looked at export time, rendered at ${renderOpts.width}x${renderOpts.height} logical pixels at ${renderOpts.scale}x. They are images, not live charts, so there is nothing to click and no underlying data in them. Use them for slides, tickets, and documents.`
    );
  }
  if (counts.pagePpt > 0) {
    lines.push(
      '- **Page decks** open in PowerPoint, Keynote, or Google Slides. They are the older binary `.ppt` format because that is what the Domo export produces; every app named above reads it.'
    );
  }
  if (counts.cardJson > 0) {
    lines.push(
      '- **Card definition JSON** is how the card is built, not how it looked. For a chart card that is the Analyzer definition: chart type and every chart property, the query each part of the card runs against its dataset (columns, aggregations, filters, date range and grain, sorting), slicer controls, segments, conditional formats, beast mode formulas, drill path, and the dataset column list. For a notebook card it is the card\'s content: the rich-text markup and the rendered HTML. Read it to answer "how was this number calculated" or to rebuild the card somewhere else. Doc and image cards have no such definition, so they get no JSON.'
    );
  }
  if (counts.cardFile > 0) {
    lines.push(
      '- **Original card files** are the exact files someone uploaded to Domo, with their original names, so they open in whatever made them. For a doc or image card that is the card itself; for a notebook card it is whatever was embedded in the text, so those sit next to the notebook render sharing its number prefix.'
    );
  }
  if (counts.datasets > 0) {
    lines.push(
      `- **Datasets** are full ${datasetFormat === 'csv' ? 'CSV' : 'Excel'} exports with a header row and no row limit. They hold the numbers behind the cards, so use them for any analysis, not the card images.`
    );
  }
  lines.push('');

  lines.push('## Worth knowing');
  lines.push('');
  lines.push('- This is a point-in-time copy. Nothing here refreshes, and it is disconnected from Domo, so anything changing in the source dashboard will not show up here.');
  lines.push(
    '- The exports carry no Domo permissions with them. Anyone who can open the folder can read every card and every row, including whatever was restricted in Domo, so treat it as sensitive and share it deliberately.'
  );
  if (counts.pagePpt > 0) {
    lines.push("- Page decks contain chart cards only. Doc and image cards are dropped by Domo's deck export, which is why their original files sit in the `cards/` folders instead.");
  }
  if (suspect.length > 0) {
    const affected = suspect.reduce((total, group) => total + group.cards.length, 0);
    lines.push(
      `- ${affected} card render${affected === 1 ? '' : 's'} came out byte-identical to another card, meaning the card drew nothing: usually it had no data in its filtered range. Those files exist but are blank. See the run log for the list.`
    );
  }
  if (errors.length > 0) {
    lines.push(`- ${errors.length} item${errors.length === 1 ? '' : 's'} failed and ${errors.length === 1 ? 'is' : 'are'} missing from this folder. See ${fileLink('errors.txt', 'errors.txt')}.`);
  }
  lines.push('');
  lines.push('## Reproducing this export');
  lines.push('');
  lines.push('```bash');
  lines.push(commandLine);
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

function countPages(node) {
  const self = node.id ? 1 : 0;
  return self + node.children.reduce((total, child) => total + countPages(child), 0);
}

function pad(index) {
  return String(index + 1).padStart(2, '0');
}

async function main() {
  showHelp(argv, HELP_TEXT);

  const pageId = argv['page-id'];
  const dataAppId = argv['dataapp-id'];

  if (!pageId && !dataAppId) {
    console.error('Error: one of --page-id or --dataapp-id is required\n');
    console.error(HELP_TEXT);
    process.exit(1);
  }
  if (pageId && dataAppId) {
    console.error('Error: --page-id and --dataapp-id are mutually exclusive\n');
    process.exit(1);
  }

  const datasetFormat = (argv['dataset-format'] || 'xlsx').toLowerCase();
  if (datasetFormat !== 'xlsx' && datasetFormat !== 'csv') {
    console.error(`Error: --dataset-format must be "xlsx" or "csv" (got "${datasetFormat}")\n`);
    process.exit(1);
  }

  const indexFormat = (argv['index-format'] || 'xlsx').toLowerCase();
  if (indexFormat !== 'xlsx' && indexFormat !== 'csv') {
    console.error(`Error: --index-format must be "xlsx" or "csv" (got "${indexFormat}")\n`);
    process.exit(1);
  }

  const dryRun = argv['dry-run'] || false;
  const clearPages = argv.clear || false;
  const includeSubpages = argv.subpages !== false;
  const wantCardPdf = argv['card-pdf'] !== false;
  const wantCardImage = argv['card-image'] !== false;
  const wantCardJson = argv['card-json'] !== false;
  const wantCardIndex = argv['card-index'] !== false;
  const wantPagePpt = argv['page-ppt'] !== false;
  const wantDocuments = argv.documents !== false;
  const wantDatasets = argv.datasets !== false;

  const renderOpts = {
    width: parseInt(argv.width, 10) || 1920,
    height: parseInt(argv.height, 10) || 1116,
    scale: parseFloat(argv.scale) || 2,
    locale: argv.locale || 'en-US'
  };

  console.log('Export Dashboard Content');
  console.log('========================\n');
  if (dryRun) console.log('DRY RUN (nothing will be downloaded)\n');

  const startedAt = new Date();
  const seen = new Set();
  const tree = dataAppId ? await getDataAppTree(dataAppId, includeSubpages, seen) : await getPageTree(pageId, includeSubpages, seen);

  // Date only, in local time, so a second export on the same day lands in the
  // same folder and overwrites rather than piling up a new one per run. The
  // exact time lives in the generated README.
  const outputDir = path.resolve(argv.output || argv.o || path.join('exports', `${safeName(tree.title, 'dashboard')}_${localDate(startedAt)}`));
  const datasetDir = path.join(outputDir, 'datasets');

  const totalPages = countPages(tree);
  console.log(`Root:        ${tree.title}${tree.id ? ` (${tree.id})` : ''}`);
  console.log(`Pages:       ${totalPages}${includeSubpages ? ' (including subpages)' : ' (subpages skipped)'}`);
  console.log(`Output:      ${outputDir}`);
  console.log(`Card PDF:    ${wantCardPdf ? 'yes' : 'no'}`);
  console.log(`Card image:  ${wantCardImage ? 'yes' : 'no'}`);
  console.log(`Card JSON:   ${wantCardJson ? 'yes' : 'no'}`);
  console.log(`Card index:  ${wantCardIndex ? indexFormat : 'no'}`);
  console.log(`Page deck:   ${wantPagePpt ? 'ppt' : 'no'}`);
  console.log(`Doc files:   ${wantDocuments ? 'yes' : 'no'}`);
  console.log(`Datasets:    ${wantDatasets ? datasetFormat : 'no'}`);
  console.log(`Clear first: ${clearPages ? 'yes (page folders are deleted before writing)' : 'no'}\n`);

  const logger = createLogger('exportDashboardContent', {
    debugMode: false,
    dryRun,
    runMeta: {
      rootPageId: pageId ? String(pageId) : null,
      dataAppId: dataAppId ? String(dataAppId) : null,
      rootTitle: tree.title,
      outputDir,
      includeSubpages,
      datasetFormat,
      totalPages,
      clearPages
    }
  });

  const datasets = new Map();
  const pageReports = [];
  const indexRows = [];
  const errors = [];
  const counts = { cardPdf: 0, cardImage: 0, cardJson: 0, cardFile: 0, pagePpt: 0, datasets: 0 };
  // A render is content-derived, so two different cards producing byte-identical
  // output means the renderer handed back a placeholder ("Unable to load card")
  // or a blank frame with an HTTP 200. Grouping by digest is what surfaces those.
  const digests = new Map();
  const usedPageDirs = new Set();
  let errorCount = 0;
  let skipCount = 0;
  let pageIndex = 0;
  let cardIndexRows = 0;

  function record(entry) {
    logger.addResult(entry);
    if (entry.status === 'error') {
      errorCount++;
      errors.push({ ...entry, at: new Date().toISOString() });
    } else if (entry.status === 'skipped') skipCount++;
  }

  function trackDigest(format, digest, info) {
    const key = `${format}:${digest}`;
    if (!digests.has(key)) digests.set(key, { format, digest, cards: [] });
    digests.get(key).cards.push(info);
  }

  async function processPage(node, parentDir, depth = 0) {
    // Page folders carry no order prefix, so two siblings sharing a title would
    // otherwise collide into one folder and overwrite each other.
    let dirName = safeName(node.title, `page_${node.id}`);
    if (usedPageDirs.has(path.join(parentDir, dirName.toLowerCase()))) {
      dirName = `${dirName} (${node.id})`;
    }
    usedPageDirs.add(path.join(parentDir, dirName.toLowerCase()));
    const pageDir = path.join(parentDir, dirName);
    pageIndex++;
    console.log(`[${pageIndex}/${totalPages}] ${node.title} (${node.id})`);

    // Safe to remove the whole subtree: a parent is always cleared before its
    // subpages are walked, so this never deletes output from the current run.
    if (clearPages && !dryRun && fs.existsSync(pageDir)) {
      fs.rmSync(pageDir, { force: true, recursive: true });
      console.log(`  cleared ${path.relative(outputDir, pageDir)}/`);
    }

    let cards = [];
    try {
      cards = (await api.get(`/content/v1/pages/${node.id}/cards?parts=metadata`)) || [];
    } catch (error) {
      console.error(`  ✗ Could not list cards: ${error.message}`);
      record({
        kind: 'page-cards',
        pageId: node.id,
        pageTitle: node.title,
        status: 'error',
        error: error.message
      });
    }
    console.log(`  ${cards.length} card(s)`);

    const pageReport = {
      id: node.id,
      title: node.title,
      depth,
      dir: path.relative(outputDir, pageDir),
      cardCount: cards.length,
      types: cards.reduce((tally, card) => {
        tally[card.type] = (tally[card.type] || 0) + 1;
        return tally;
      }, {}),
      deck: null,
      cardsDir: null
    };
    pageReports.push(pageReport);

    if (wantPagePpt) {
      const destPath = path.join(pageDir, `_page_${safeName(node.title, node.id)}.ppt`);
      // Doc and image cards are dropped by the export, so leaving them out
      // keeps the request honest about what the deck will contain.
      const deckCards = cards.filter((card) => !FILE_CARD_TYPES.has(card.type));
      const dropped = cards.length - deckCards.length;

      if (deckCards.length === 0) {
        console.log('  - Page deck skipped (no cards the export can render)');
        record({
          kind: 'page-ppt',
          pageId: node.id,
          pageTitle: node.title,
          status: 'skipped',
          reason: 'no renderable cards'
        });
      } else if (dryRun) {
        console.log(`  [DRY RUN] Would export page deck (${deckCards.length} cards) → ${destPath}`);
        record({ kind: 'page-ppt', pageId: node.id, status: 'dry-run', path: destPath });
      } else {
        try {
          const result = await exportPagePpt(
            node.title,
            deckCards.map((card) => card.id),
            destPath
          );
          const note = dropped > 0 ? `, ${dropped} file card(s) excluded` : '';
          console.log(`  ✓ Page deck (${deckCards.length} cards${note}, ${result.bytes} bytes)`);
          counts.pagePpt++;
          pageReport.deck = { file: path.basename(destPath), cards: deckCards.length, excluded: dropped };
          record({
            kind: 'page-ppt',
            pageId: node.id,
            status: 'exported',
            path: destPath,
            bytes: result.bytes,
            cardCount: deckCards.length,
            excludedFileCards: dropped
          });
        } catch (error) {
          console.error(`  ✗ Page deck failed: ${error.message}`);
          record({ kind: 'page-ppt', pageId: node.id, status: 'error', error: error.message });
        }
      }
    }

    let cardDatasets = new Map();
    if (wantCardIndex && cards.length > 0) {
      try {
        cardDatasets = await fetchCardDatasets(cards.map((card) => card.id));
        for (const list of cardDatasets.values()) {
          for (const dataset of list) {
            if (!dataset.dataSourceId) continue;
            if (!datasets.has(dataset.dataSourceId)) {
              datasets.set(dataset.dataSourceId, {
                id: dataset.dataSourceId,
                name: dataset.dataSourceName || dataset.dataSourceId,
                usedByCard: true
              });
            } else {
              datasets.get(dataset.dataSourceId).usedByCard = true;
            }
          }
        }
      } catch (error) {
        // A failed lookup leaves the dataset columns blank rather than killing the page.
        console.error(`  ✗ Could not map cards to datasets: ${error.message}`);
        record({ kind: 'card-datasets', pageId: node.id, status: 'error', error: error.message });
      }
    }

    const cardsDir = path.join(pageDir, 'cards');
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const title = safeName(card.title, `card_${card.id}`);
      const prefix = pad(i);
      const isFileCard = FILE_CARD_TYPES.has(card.type);
      const isNotebookCard = NOTEBOOK_CARD_TYPES.has(card.type);
      const cardFiles = [];
      console.log(`  [${i + 1}/${cards.length}] ${card.title || card.id} (${card.type})`);

      if ((isFileCard || isNotebookCard) && wantDocuments) {
        const refs = dataFileRefs(card);
        // A doc card with nothing attached is broken; a notebook with no
        // embedded files is the ordinary case and not worth recording.
        if (refs.length === 0 && isFileCard) {
          console.log('    - No file attached');
          record({ kind: 'card-file', cardId: card.id, pageId: node.id, status: 'skipped', reason: 'no data file' });
        }
        for (const ref of refs) {
          if (dryRun) {
            console.log(`    [DRY RUN] Would download data file ${ref.fileId}`);
            record({ kind: 'card-file', cardId: card.id, pageId: node.id, status: 'dry-run', fileId: ref.fileId });
            continue;
          }
          try {
            const result = await downloadCardFile(ref, title, cardsDir, prefix);
            console.log(`    ✓ File (${result.bytes} bytes) → ${path.basename(result.path)}`);
            counts.cardFile++;
            cardFiles.push(result.path);
            record({
              kind: 'card-file',
              cardId: card.id,
              pageId: node.id,
              status: 'exported',
              path: result.path,
              bytes: result.bytes
            });
          } catch (error) {
            console.error(`    ✗ File failed: ${error.message}`);
            record({ kind: 'card-file', cardId: card.id, pageId: node.id, status: 'error', error: error.message });
          }
        }
      }

      if (!isFileCard && wantCardJson) {
        const jsonPath = path.join(cardsDir, `${prefix}_${title}.json`);
        if (dryRun) {
          console.log(`    [DRY RUN] Would export definition → ${jsonPath}`);
          record({ kind: 'card-json', cardId: card.id, pageId: node.id, status: 'dry-run', path: jsonPath });
        } else {
          try {
            const result = await exportCardDefinition(card, jsonPath);
            console.log(`    ✓ Definition (${result.bytes} bytes)`);
            counts.cardJson++;
            cardFiles.push(jsonPath);
            record({ kind: 'card-json', cardId: card.id, pageId: node.id, status: 'exported', path: jsonPath, bytes: result.bytes });
          } catch (error) {
            console.error(`    ✗ Definition failed: ${error.message}`);
            record({ kind: 'card-json', cardId: card.id, pageId: node.id, status: 'error', error: error.message });
          }
        }
      }

      // Doc/image cards have no chart to draw: the renderer returns an
      // "Unable to load card" placeholder for them, and the original file
      // downloaded above is the actual content.
      if (!isFileCard && (wantCardPdf || wantCardImage)) {
        const pngPath = path.join(cardsDir, `${prefix}_${title}.png`);
        const pdfPath = path.join(cardsDir, `${prefix}_${title}.pdf`);

        if (dryRun) {
          if (wantCardImage) {
            console.log(`    [DRY RUN] Would render PNG → ${pngPath}`);
            record({ kind: 'card-png', cardId: card.id, pageId: node.id, status: 'dry-run', path: pngPath });
          }
          if (wantCardPdf) {
            console.log(`    [DRY RUN] Would render PDF → ${pdfPath}`);
            record({ kind: 'card-pdf', cardId: card.id, pageId: node.id, status: 'dry-run', path: pdfPath });
          }
        } else {
          try {
            // One render serves both outputs; the PDF is that PNG on a page.
            const png = await renderCardPng(card.id, renderOpts);
            trackDigest('render', crypto.createHash('sha256').update(png).digest('hex'), {
              cardId: card.id,
              cardTitle: card.title,
              pageId: node.id,
              path: pngPath
            });

            if (wantCardImage) {
              const result = writeRender(png, pngPath);
              console.log(`    ✓ PNG (${result.bytes} bytes)`);
              counts.cardImage++;
              cardFiles.push(pngPath);
              record({ kind: 'card-png', cardId: card.id, pageId: node.id, status: 'exported', path: pngPath, bytes: result.bytes });
            }
            if (wantCardPdf) {
              const result = writeRender(await pngToPdf(png), pdfPath);
              console.log(`    ✓ PDF (${result.bytes} bytes)`);
              counts.cardPdf++;
              cardFiles.push(pdfPath);
              record({ kind: 'card-pdf', cardId: card.id, pageId: node.id, status: 'exported', path: pdfPath, bytes: result.bytes });
            }
          } catch (error) {
            console.error(`    ✗ Render failed: ${error.message}`);
            record({ kind: 'card-render', cardId: card.id, pageId: node.id, status: 'error', error: error.message });
          }
        }
      } else if (isFileCard && (wantCardPdf || wantCardImage)) {
        console.log('    - Renders skipped (file card; original downloaded instead)');
      }

      if (wantCardIndex) {
        const files = cardFiles.map((file) => path.relative(outputDir, file)).join('; ');
        const used = cardDatasets.get(String(card.id)) || [];
        const base = [node.title, node.id, pageReport.dir || '.', card.title || '', card.id, card.type, files];
        const cardLink = `${config.instanceUrl}/kpis/details/${card.id}`;
        // A card reading two datasets gets a row each; one reading none still gets
        // a row, so the index doubles as an inventory of everything exported.
        if (used.length === 0) {
          indexRows.push([...base, '', '', '', '', cardLink, '']);
        }
        for (const dataset of used) {
          indexRows.push([
            ...base,
            dataset.dataSourceName || '',
            dataset.dataSourceId || '',
            dataset.dataType || '',
            '',
            cardLink,
            dataset.dataSourceId ? `${config.instanceUrl}/datasources/${dataset.dataSourceId}/details/overview` : ''
          ]);
        }
      }

      if (i < cards.length - 1) await delay(150);
    }

    // Only link the folder if something actually landed in it: a page whose
    // cards all failed, or one exported with every card output turned off,
    // never creates it.
    if (fs.existsSync(cardsDir)) pageReport.cardsDir = path.relative(outputDir, cardsDir);

    if (wantDatasets) {
      try {
        const details = await api.get(`/content/v1/datasources/pages/${node.id}`);
        for (const dataset of (details && details.dataSources) || []) {
          if (dataset.id && !datasets.has(dataset.id)) {
            datasets.set(dataset.id, { id: dataset.id, name: dataset.name || dataset.id });
          }
        }
      } catch (error) {
        console.error(`  ✗ Could not list datasets: ${error.message}`);
        record({ kind: 'page-datasets', pageId: node.id, status: 'error', error: error.message });
      }
    }

    console.log('');

    for (const child of node.children) {
      await processPage(child, pageDir, depth + 1);
    }
  }

  if (tree.id) {
    await processPage(tree, outputDir, 0);
  } else {
    for (const child of tree.children) {
      await processPage(child, outputDir, 0);
    }
  }

  if (wantDatasets && datasets.size > 0) {
    console.log(`=== Datasets (${datasets.size}) ===`);
    const list = [...datasets.values()];
    for (let i = 0; i < list.length; i++) {
      const dataset = list[i];
      console.log(`[${i + 1}/${list.length}] ${dataset.name} (${dataset.id})`);
      if (dryRun) {
        console.log(`  [DRY RUN] Would export as ${datasetFormat}`);
        record({ kind: 'dataset', datasetId: dataset.id, status: 'dry-run' });
        continue;
      }
      try {
        const result = await exportDataset(dataset, datasetDir, datasetFormat);
        console.log(`  ✓ Exported (${result.bytes} bytes)`);
        counts.datasets++;
        dataset.file = path.basename(result.path);
        dataset.bytes = result.bytes;
        record({
          kind: 'dataset',
          datasetId: dataset.id,
          datasetName: dataset.name,
          status: 'exported',
          path: result.path,
          bytes: result.bytes
        });
      } catch (error) {
        console.error(`  ✗ Export failed: ${error.message}`);
        record({ kind: 'dataset', datasetId: dataset.id, status: 'error', error: error.message });
      }
      if (i < list.length - 1) await delay(200);
    }
    console.log('');
  }

  // One card placed on several pages is rendered once per page and will of
  // course match itself, so only distinct cards sharing a digest are suspect.
  const suspect = [...digests.values()].filter((group) => new Set(group.cards.map((card) => String(card.cardId))).size > 1);
  if (suspect.length > 0) {
    const affected = suspect.reduce((total, group) => total + group.cards.length, 0);
    console.log(`=== Suspect renders (${affected}) ===`);
    console.log('These cards rendered to byte-identical output, so they carry no');
    console.log('content of their own: either the card had no data to draw, or the');
    console.log('renderer returned a placeholder instead of the card.');
    console.log('The files are still on disk; check them before relying on them.\n');
    for (const group of suspect) {
      console.log(`  ${group.format} ${group.digest.slice(0, 12)}: ${group.cards.length} cards:`);
      for (const card of group.cards) {
        console.log(`    ${card.cardId} ${card.cardTitle || ''} (page ${card.pageId})`);
      }
      record({
        kind: `suspect-${group.format}`,
        status: 'suspect',
        digest: group.digest,
        cards: group.cards
      });
    }
    console.log('');
  }

  if (!dryRun && fs.existsSync(outputDir)) {
    const readmePath = path.join(outputDir, 'README.md');
    const errorLogPath = path.join(outputDir, 'errors.txt');
    const meta = { rootTitle: tree.title, instance: config.instance, startedAt: formatExportedAt(startedAt) };

    if (wantCardIndex) {
      // Datasets are exported after the whole tree is walked, so the workbook
      // name is only known now.
      for (const row of indexRows) {
        const dataset = row[8] ? datasets.get(row[8]) : null;
        if (dataset && dataset.file) row[10] = path.join('datasets', dataset.file);
      }
      const indexPath = path.join(outputDir, `cards.${indexFormat}`);
      const stale = path.join(outputDir, `cards.${indexFormat === 'csv' ? 'xlsx' : 'csv'}`);
      if (fs.existsSync(stale)) fs.unlinkSync(stale);
      const result = writeCardIndex(indexPath, indexRows, indexFormat);
      cardIndexRows = indexRows.length;
      console.log(`Card index written to ${indexPath} (${indexRows.length} rows, ${result.bytes} bytes)`);
    }

    fs.writeFileSync(
      readmePath,
      buildReadme({
        ...meta,
        rootId: dataAppId ? String(dataAppId) : String(pageId),
        isDataApp: !!dataAppId,
        durationMs: Date.now() - startedAt.getTime(),
        pageReports,
        datasets: [...datasets.values()],
        counts,
        totalCards: pageReports.reduce((total, page) => total + page.cardCount, 0),
        totalBytes: dirSize(outputDir),
        suspect,
        errors,
        datasetFormat,
        renderOpts,
        clearPages,
        cardIndex: cardIndexRows > 0 ? { file: `cards.${indexFormat}`, rows: cardIndexRows } : null,
        commandLine: `node cli.js export-dashboard-content ${process.argv.slice(2).map(shellQuote).join(' ')}`
      })
    );
    console.log(`README written to ${readmePath}`);

    if (errors.length > 0) {
      fs.writeFileSync(errorLogPath, buildErrorLog(errors, meta));
      console.log(`Error log written to ${errorLogPath}`);
    } else if (fs.existsSync(errorLogPath)) {
      // A clean re-run into the same folder must not leave the old failures behind.
      fs.unlinkSync(errorLogPath);
    }
    console.log('');
  }

  console.log('=== Summary ===');
  console.log(`Pages:        ${totalPages}`);
  console.log(`Page decks:   ${counts.pagePpt}`);
  console.log(`Card PDFs:    ${counts.cardPdf}`);
  console.log(`Card images:  ${counts.cardImage}`);
  console.log(`Card JSON:    ${counts.cardJson}`);
  console.log(`Card files:   ${counts.cardFile}`);
  console.log(`Datasets:     ${counts.datasets}`);
  console.log(`Index rows:   ${cardIndexRows}`);
  console.log(`Skipped:      ${skipCount}`);
  console.log(`Suspect:      ${suspect.reduce((total, group) => total + group.cards.length, 0)}`);
  console.log(`Errors:       ${errorCount}`);
  if (!dryRun) console.log(`\nOutput: ${outputDir}`);

  logger.writeRunLog({
    ...counts,
    totalPages,
    cardIndexRows,
    skipCount,
    suspectCount: suspect.reduce((total, group) => total + group.cards.length, 0),
    errorCount
  });

  if (errorCount > 0) {
    console.error('\nSome exports failed. Check the error messages above.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
