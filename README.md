# domo-scripts

CLI toolkit for automating and managing [Domo](https://www.domo.com/) business intelligence instances. Bulk operations on DataFlows, DataSets, Streams, PDP policies, content sharing, and more — all through a single entry point.

## Setup

```bash
git clone <repo-url>
cd domo-scripts
yarn install
cp .env.example .env
```

Edit `.env` with your Domo credentials:

```
DOMO_INSTANCE=your-instance
DOMO_ACCESS_TOKEN=your-access-token
```

The instance name is the subdomain from your Domo URL (`https://<instance>.domo.com`).

## Usage

```bash
node cli.js <command> [options]
node cli.js --help                    # List all commands
node cli.js <command> --help          # Command-specific options
```

### Quick Examples

```bash
# Update stream schedules to once daily between 6 AM and 8 PM
node cli.js update-stream-schedules --file "streams.csv" --startHour 6 --endHour 20

# Add trigger conditions to dataflows from a CSV
node cli.js bulk-add-dataflow-trigger-condition --file "dataflows.csv" --column "DataFlow ID"

# Or pass a single ID for debug logging
node cli.js bulk-add-dataflow-trigger-condition --dataflowId 123

# Upload data to a dataset in batches
node cli.js upload-dataset --file "data.csv" --datasetId "abc-123" --batchSize 50000

# Share content with a user
node cli.js share-content-bulk --file "content.csv" --user "12345" --contentType "card"

# Preview destructive changes with dry run
node cli.js bulk-delete-datasets --file "datasets.csv" --dryRun

# Filter CSV input before processing
node cli.js update-stream-schedules --file "streams.csv" --filterColumn "status" --filterValue "ACTIVE"
```

## Commands

| Command | Description |
|---------|-------------|
| `bulk-add-dataflow-tags` | Add tags to dataflows from a CSV or by owner |
| `bulk-add-dataflow-trigger-condition` | Add DATAFLOW_LAST_RUN trigger conditions to dataflow triggers |
| `bulk-add-dataset-tags` | Add tags to datasets from a CSV or by owner |
| `bulk-apply-pdp-policies` | Copy PDP policies from a source dataset to target datasets |
| `bulk-approve-dataflow-schedules` | Approve pending dataflow schedule changes |
| `bulk-approve-dataset-schedules` | Approve pending dataset schedule changes |
| `bulk-delete-datasets` | Delete datasets listed in a CSV |
| `bulk-rename-dataflows` | Find/replace in dataflow names across the instance |
| `bulk-rename-datasets` | Find/replace in dataset names across the instance |
| `bulk-update-streams` | Update stream definitions from JSON files |
| `compare-cards` | Compare card definitions between two JSON exports |
| `convert-stream-provider` | Convert streams from one connector type to another |
| `copy-dataflow` | Copy a dataflow JSON definition with cleaned properties |
| `create-beast-modes` | Create Beast Mode formulas from an output dataset JSON |
| `create-dataflow` | Create a dataflow from a local JSON definition with ID mapping |
| `create-stream` | Create a stream and its input dataset from a JSON definition |
| `export-dataset-versions` | Export historical versions of a dataset |
| `extract-card-ids` | Extract card IDs from a page export JSON |
| `get-page-cards` | Fetch and save all card definitions from a Domo page |
| `json-array-length` | Count elements in a JSON array file |
| `query-to-json` | Query a dataset and export results as JSON |
| `read-account-credentials` | Read account credential details |
| `revoke-content-bulk` | Revoke access to content in bulk |
| `run-workflow-in-batches` | Execute a workflow with batched input |
| `share-content-bulk` | Share content (cards, datasets, pages, dataflows) with users/groups |
| `swap-input-in-dataflows` | Replace a dataset input across all consuming dataflows |
| `switch-provider` | Switch a stream's connector provider and account |
| `update-column-pdp-policy` | Update users/groups on a column-based PDP policy |
| `update-stream-schedules` | Change stream schedules to daily or manual (with randomized times) |
| `upload-dataset` | Upload CSV data to a dataset in configurable batches |
| `user-attribute-updates-workflow-run` | Trigger user attribute update workflows from a CSV |

## Common Options

Most bulk commands that process a list of IDs support these options:

| Option | Description |
|--------|-------------|
| `--file`, `-f` | Path to a CSV file containing IDs |
| `--column`, `-c` | CSV column name to extract IDs from |
| `--<entity>Id` | Single ID (enables detailed debug logging) |
| `--<entity>Ids` | Comma-separated IDs |
| `--filterColumn` | Filter CSV rows: column name to match |
| `--filterValue` | Filter CSV rows: required value |
| `--dry-run` | Preview changes without applying them |

## Project Structure

```
domo-scripts/
├── cli.js              # Entry point — dispatches to commands
├── lib/
│   ├── index.js        # Re-exports all shared modules
│   ├── config.js       # Environment config and auth
│   ├── api.js          # Authenticated Domo API client (get/put/post/del)
│   ├── csv.js          # CSV parsing with optional filtering
│   ├── input.js        # Resolve IDs from CSV/flags
│   └── log.js          # Debug and run log utilities
├── commands/           # One file per command (31 total)
├── logs/               # Generated run/debug logs (git-ignored)
├── .env                # Your credentials (git-ignored)
└── .env.example        # Template for .env
```

### Adding a New Command

1. Create `commands/your-command.js`
2. Import shared libs: `const { api, resolveIds, createLogger } = require('../lib');`
3. Add `--help` handling before any API calls
4. Register it in the `commands` map in `cli.js`

## Logging

Commands that support logging write JSON files to `logs/<commandName>/`:

- **Run logs** (`run_<timestamp>.json`) — summary of all items processed in a bulk run
- **Debug logs** (`debug_<itemId>_<timestamp>.json`) — detailed per-item logs when using `--<entity>Id`
- Dry-run variants are prefixed with `dry_`
