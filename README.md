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

### Multiple Environments

To target more than one Domo instance, create a per-environment file alongside `.env`:

```
.env.prod        # DOMO_INSTANCE=acme-prod, DOMO_ACCESS_TOKEN=...
.env.sandbox     # DOMO_INSTANCE=acme-sandbox, DOMO_ACCESS_TOKEN=...
```

Select one at runtime with `--env <name>`:

```bash
node cli.js --env prod bulk-rename-datasets --file ds.csv
node cli.js --env sandbox bulk-rename-datasets --file ds.csv --dry-run
```

`.env.*` files are git-ignored. A bare `.env` is still loaded as a fallback for any shared defaults.

### Transferring Between Instances

Migration commands (e.g. `transfer-stream`) operate on two instances at once. Pass both env names:

```bash
node cli.js transfer-stream --source-env prod --target-env sandbox --stream-id 12345
node cli.js transfer-stream --source-env prod --target-env sandbox --file streams.csv --dry-run
```

Each transfer records old→new IDs in `id-mappings/<source>_to_<target>.json` (also git-ignored), so multiple instance pairs can coexist (`prod_to_sandbox.json`, `prod_to_dev.json`, etc.). Some kinds — accounts, users, providers — must be pre-populated by hand before transferring assets that reference them; commands abort with a clear error if a required mapping is missing.

## Usage

```bash
node cli.js [--env <name>] <command> [options]
node cli.js --help                    # List all commands
node cli.js <command> --help          # Command-specific options
```

### Quick Examples

```bash
# Update stream schedules to once daily between 6 AM and 8 PM
node cli.js bulk-update-stream-schedules --file "streams.csv" --start-hour 6 --end-hour 20

# Add trigger conditions to dataflows from a CSV
node cli.js bulk-add-dataflow-trigger-condition --file "dataflows.csv" --column "DataFlow ID"

# Or pass a single ID for debug logging
node cli.js bulk-add-dataflow-trigger-condition --dataflow-id 123

# Upload data to a dataset in batches
node cli.js upload-dataset --file "data.csv" --dataset-id "abc-123" --batch-size 50000

# Share content with a user
node cli.js bulk-share-content --file "content.csv" --user "12345" --content-type "card"

# Preview destructive changes with dry run
node cli.js bulk-delete-datasets --file "datasets.csv" --dry-run

# Filter CSV input before processing
node cli.js bulk-update-stream-schedules --file "streams.csv" --filter-column "status" --filter-value "ACTIVE"
```

## Commands

| Command | Description |
|---------|-------------|
| `bulk-add-dataflow-tags` | Add tags to dataflows from a CSV or by owner |
| `bulk-add-dataflow-trigger-condition` | Add DATAFLOW_LAST_RUN trigger conditions to dataflow triggers |
| `bulk-add-dataset-tags` | Add tags to datasets from a CSV or by owner |
| `bulk-apply-pdp-policies` | Copy PDP policies from a source dataset to target datasets |
| `bulk-convert-stream-provider` | Convert streams from one connector type to another |
| `bulk-delete-datasets` | Delete datasets listed in a CSV |
| `bulk-delete-users` | Delete users listed in a CSV. Does not check or transfer ownership — prompts for confirmation. |
| `bulk-export-dataset-versions` | Export historical versions of a dataset |
| `bulk-list-user-content` | List everything a set of users own (datasets, cards, pages, etc.) into a single CSV — one row per (user, object) |
| `bulk-rename-dataflows` | Find/replace in dataflow names across the instance |
| `bulk-rename-datasets` | Find/replace in dataset names across the instance |
| `bulk-revoke-access-tokens` | Revoke developer access tokens by ID, CSV, owner, expiration, or deleted owner |
| `bulk-unshare-content` | Unshare content in bulk |
| `bulk-share-content` | Share content (cards, datasets, pages, dataflows) with users/groups |
| `bulk-transfer-ownership` | Transfer ownership of a user's content (datasets, cards, pages, etc.) to a new owner, either all discovered from the user or from a CSV |
| `bulk-update-column-pdp-policy` | Update users/groups on a column-based PDP policy |
| `bulk-update-stream-schedules` | Change stream schedules to daily or manual (with randomized times) |
| `bulk-update-stream-update-method` | Change stream update mode from Replace to Append |
| `extract-card-ids` | Extract card IDs from a page export JSON |
| `swap-input-in-dataflows` | Replace a dataset input across all consuming dataflows |
| `transfer-stream` | Copy a stream (and its input dataset) from one instance to another |
| `upload-dataset` | Upload CSV data to a dataset in configurable batches |

## Common Options

Most bulk commands that process a list of IDs support these options:

| Option | Description |
|--------|-------------|
| `--file`, `-f` | Path to a CSV file containing IDs |
| `--column`, `-c` | CSV column name to extract IDs from |
| `--<entity>-id` | Single ID (enables detailed debug logging) |
| `--<entity>-ids` | Comma-separated IDs |
| `--filter-column` | Filter CSV rows: column name to match |
| `--filter-value` | Filter CSV rows: required value |
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
├── commands/           # One file per command (17 total)
├── logs/               # Generated run/debug logs (git-ignored)
├── .env                # Your credentials (git-ignored)
├── .env.<name>         # Per-environment credentials, selected with --env (git-ignored)
├── .env.example        # Template for .env
└── id-mappings/        # Per-env-pair old→new ID mappings, written by transfer commands (git-ignored)
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
