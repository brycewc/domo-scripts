# MajorDomo governance datasets

Often cheaper, fresher and more complete than sweeping the API, and queryable with SQL via
`POST /query/v1/execute/{datasetId}` with `{sql}`. Find others with a search-index query for
`MajorDomo` over `entityList: [["dataset"]]`.

IDs below are from `domo.domo.com`; re-resolve by name on another instance.

| Dataset | ID | Use it for |
|---|---|---|
| `GOLD \| MajorDomo \| Activity Log` | `0b09a9d5-0e59-4650-9626-083349d0c419` | **The best primary evidence source found so far.** 184M rows, 2018-03-03 to the current hour, event-level with `User ID`/`User Name` attribution *and* `Object Owner ID`. Covers Card, Page, App Studio Page, DataSet, AppDB Collection, AppDB Datastore, Beast Mode Formula, Approval, Queue Task, Workflow Execution, Report Schedule, Project and more. Replaces the day-chunked `/audit/v1/user-audits` sweep: seconds instead of ~3 hours, and it reaches back past the window so a zero can be read in context |
| `RAW \| MajorDomo \| Cards by Page` | `28a51004-eb61-4a10-a0a5-0ddc3119b6c4` | card-to-container mapping with ids: `cardId`, `pageId`, `pageType` (`PAGE` / `APP_PAGE` / `UNKNOWN`). The only workable route to container ids, since `parts=pages` on the cards endpoint returns empty |
| `RAW \| MajorDomo \| App Studio Pages` | `7eae2815-2363-4842-a55e-1f72e97251bf` | `App ID` → `App Page Id`, so an app-page id resolves to the app whose owners you need |
| `GOLD \| MajorDomo \| Pages` | `05c8238a-4dbc-4a0e-ad83-73a837cceb62` | per-page `Views`, `Last Viewed Timestamp`, `Cards`, `Full Path`. **`Owner ID` is blank for multi-owner pages** — do not filter on it |
| `GOLD \| MajorDomo \| Accounts` | `a13231e6-6d97-4e1b-941b-5ef30d66bfab` | `Direct Dependencies` = DataSets + Jupyter Workspaces + Code Engine Packages + Workflows + Cloud Integrations. One row per account; `Owner ID` is blank when multi-owner, with `Owner Name` a concatenated list |
| `GOLD \| MajorDomo \| DataSets` | `a40d44a7-c399-4949-9d16-6f9fccd331cc` | `Cards`, `Impacted Cards`, `Child DataFlows`, `Workflows`, `Code Engine Packages`, `Direct Dependencies`, `Total Impact`, `Rows`, `Last Touched Timestamp` |
| `GOLD \| MajorDomo \| DataFlows by Output DataSet` | `c3d97e68-0df7-4f16-ae31-ef80213b5827` | **the only clean dataset -> producing dataflow edge.** `DataFlow ID/Name`, `DataFlow Owner ID/Name/Type/Active`, `Last Run State`. Use this rather than `/data/v1/lineage/DATA_SOURCE/{id}`, which returns the whole upstream graph even with `traverseDown=false`. Essential for routing beast modes off group-owned datasets |
| `GOLD \| MajorDomo \| Users (People)` | `87276a1f-12ff-4008-904f-874966e618fa` | **the only source of org hierarchy.** `Reports To ID/Name/Email`, `HRIS Manager Name/Domo ID/Email`, `HRIS Employment Status`. None of this is on `/content/v2/users/{id}` or `/identity/v1/users/{id}`. Expect the manager fields to be **blank for terminated accounts and integration users** |
| `GOLD \| MajorDomo \| Streams` | `5849da66-b0d0-4931-8900-ac17358c7878` | the stream-to-account edge; group on `Account ID` |
| `GOLD \| MajorDomo \| Cards` | `718f1df6-3755-470e-9edc-9f110eca7e89` | `Owner ID/Name/Type`, `DataSet ID` and `DataSet Owner ID`, `Custom App ID`, `Views`, `Last Viewed Timestamp`, `Last Non-Owner Viewed Timestamp`, `Pages Full Path`. **`DataSet ID` is single-valued**, so filtering by it misses multi-dataset cards; filter by `Card ID` or `Custom App ID` instead |
| `GOLD \| MajorDomo \| Card Loads` | `ca200cbd-204f-4a40-b617-284ad4ae1307` | per-date card load telemetry with `Context`, `Views`, `Average Duration`. **Covers app cards**, unlike the card-views dataset. No viewer identity |
| `GOLD \| MajorDomo \| Activity Log Card Views with Page` | `f289d63b-837f-452b-8656-ed12bd0668ec` | event-level views **with viewer identity**, 2018 onward. Does **not** cover app cards, which is a false-negative trap |
| `GOLD \| MajorDomo \| Domo Everywhere Embed` | `75523697-752d-498f-a341-4dcb56265178` | embed type, URL and external view counts. Its "Object Owner" column is a stale snapshot; confirm owners live |
| `GOLD \| MajorDomo \| DataFlows`, `Pages`, `Groups`, `Workflows`, `Workspaces`, `Providers` | see search | per-type inventories with owner columns |

## Using the Activity Log

One query replaces most of the harvesting. Attributed activity for any object type, over any window:

```sql
SELECT `Object ID`, COUNT(*) AS events,
       SUM(CASE WHEN `Action Name` LIKE 'Viewed%' THEN 1 ELSE 0 END) AS views,
       COUNT(DISTINCT `User ID`) AS viewers, MAX(`Event Timestamp`) AS last_event
FROM table
WHERE `Object Type Name` = 'Card'            -- or 'Page', 'App Studio Page', ...
  AND `Object ID` IN (...)
  AND `Event Timestamp` >= DATE_SUB(CURRENT_DATE(), INTERVAL 180 DAY)
  AND `User ID` NOT IN (<target>, <operator>, 1486980888, 2128251904)
GROUP BY 1
```

There are **two** MajorDomo identities to exclude, not one: `1486980888` MajorDomo Service Account
and `2128251904` MajorDomo Testing.

`Object Owner ID` makes it a completeness check on the inventory as well:

```sql
SELECT `Object Type Name`, COUNT(DISTINCT `Object ID`), MAX(`Event Timestamp`)
FROM table WHERE `Object Owner ID` = <target> GROUP BY 1
```

On one account this surfaced 9 approvals, 9 queue tasks and 2 workflow executions that
`bulk-list-user-content` reported as zero, plus a live report schedule it does not scan at all. It
**under**-reports co-owned objects (the 4 co-owned pages did not appear), so treat it as a discovery
signal that adds to the inventory rather than replacing it.

Two more things worth pulling from the same place, since they answer questions nothing else does:

- **Is the account still acting?** `WHERE \`User ID\` = <target>` grouped by `Object Type Name` /
  `Action Name`, plus `Device`, `IP Address` and `Authentication Method`. This is what showed an
  "Integration User" was really a person on desktop and mobile with 179 SSO sign-ins, which changes
  the deletion risk completely.
- **Watch for `Report Schedule` / `Emailed` rows.** A schedule owned by a dormant account keeps
  mailing people and is invisible to the inventory.

Notes: string literals need single quotes (double quotes are read as identifiers), and unbounded
`COUNT(*)` over 184M rows times out — always bound with a date predicate.

**Not every column that looks like a count is one.** `GOLD | MajorDomo | DataSets`.`PDP` is the
string `'Yes'`/`'No'`, and the engine happily evaluates `'No' > 0` as true, so a numeric filter
silently matches the entire table. `GROUP BY` a column once before filtering on it, and treat a
control test that matches *every* row as failed, not passed. Result keys also do not preserve
alias casing (`AS pdp` comes back as `PDP`), so read them case-insensitively. Full write-up in
[api-traps.md](api-traps.md).

## Cautions

- **Check coverage before reading a zero as absence.** Query `MIN`/`MAX` of the timestamp column and the row count first. Two card datasets exist with different windows and different type coverage, and picking the wrong one silently returns no events for app cards.
- **Some are archived and return HTTP 410**, including `... Publications by Object`, `Prod Publication Group Pages` and `MajorDomo App Tracking`. Use the live API instead (`/publish/v2/publications` for the publish side).
- These are snapshots. For anything irreversible, confirm against the live API immediately before executing.
- Prefer them for breadth (dependency counts, view history across the whole instance) and the live API for the final pre-flight.
