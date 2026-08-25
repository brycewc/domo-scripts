# Domo API traps that produce wrong answers

Each of these was hit for real during a user decommission. They are ordered by how much damage a
wrong answer causes. Anything marked **SILENT** gives no error, just a wrong result.

## Fields that look like evidence and are not

| Field | Reality |
|---|---|
| AppDB collection `documentCount` | **SILENT.** Always `0`, for all 1,200 collections in the instance. It is unpopulated. Reading it as "empty" condemns everything. |
| Card metadata `badgeUpdated` | **SILENT.** Not a human edit. 32 cards once shared a single timestamp with zero `UPDATED` events in the audit log. It is metadata propagation. |
| Search index `datasetCount` on an account | **SILENT.** Roughly 6 months stale and counts deleted datasets. Reported 192 where the live count was 129, and claimed 1-4 datasets for five accounts that had none. |
| Dataset `cardCount` | Real, but the governance Cards table can still miss those cards. Resolve the actual card ids with `GET /data/v1/lineage/DATA_SOURCE/{id}`. |
| `Last Non-Owner Viewed Timestamp` | Excludes the *owner*, not the operator running the cleanup. Your own API poking can land in it. |
| `GOLD \| MajorDomo \| Pages`.`Owner ID` | **SILENT.** Blank for multi-owner pages, exactly like the Accounts dataset. Filtering it by owner returned **0 of one account's 4 pages**, all of which were co-owned. Use `pages/adminsummary` for page ownership. |
| Card search index `owned_by_id` | Correct, but **lags ownership writes**. Straight after a transfer it reported **13 cards still owned by the source when only 2 remained**. Fine for discovery, useless as post-execution verification. |

## Endpoints that 404 or return empty without meaning "gone"

- **`GET /apps/v1/designs/{id}` 404s for apps you do not own.** Produced "17 of 19 apps are deleted"; the true answer was 14 live. Always control-test against an app you can prove exists.
- **`GET /apps/v1/designs?checkAdminAuthority=true` is not complete.** 6,864 designs across `deleted=false` and `deleted=true`, and a provably live app appeared in neither, because **app instances are not in the design registry at all**.
- **`GET /data/v1/accounts` returns only accounts the caller can see** (142 in one instance, none of them the target's). Use the search index to scope: `POST /search/v1/query` with `entityList: [["account"]]` and a `term` filter on `owned_by_id`.
- **`GET /content/v1/cards/{id}` does not exist** (405). Use `GET /content/v1/cards?urns=<comma-separated>&parts=metadata,owners,pages,datasources`.
- **`POST /search/v1/query` filtering cards by dataset silently returns 0** for every field name tried (`datasource_id`, `datasourceid`, `dataSourceId`, ...). **SILENT.** Validate any search filter against a target you know has hits before trusting a zero.
- **`POST /content/v1/cards/adminsummary` silently ignores every owner filter. SILENT.** `ownerIds`,
  `cardOwnerIds`, `includeCardOwnerClause` and `includeOwnerClause` all return the same
  instance-wide page (`totalCardCount: 1000`), whose first row belongs to an unrelated user. The
  *pages* equivalent (`includePageOwnerClause: 1` + `ownerIds`) filters correctly, which makes the
  card version look trustworthy. Get card ownership from the search index (`owned_by_id`) or the
  governance Cards table, then confirm per card with `GET /content/v1/cards?urns=...&parts=owners`.
  `adminsummary` is still the only place `pageHierarchy` appears, so it remains useful for
  containers once you filter client-side.
- **`GET /content/v1/cards?urns=...&parts=pages` returns `[]` for every card. SILENT.** All 80 cards
  in one run came back with no containers while the governance table showed every one on at least
  one page. `parts=pageHierarchy` and `parts=fullPages` are not recognised at all. Use
  `RAW \| MajorDomo \| Cards by Page` (`cardId`, `pageId`, `pageType`) for container ids.
- **`GET /data/v1/lineage/DATA_SOURCE/{id}` traversal flags, and what neither of them gives you.**
  The two directions are selected by *disabling* the one you do not want:
  - `?traverseDown=false` walks **up** to ancestors only. On one dataset: 2,625 nodes, 775
    dataflows, and **no cards at all**, since cards are downstream.
  - `?traverseUp=false` walks **down** to descendants only, i.e. the impact side. Same dataset:
    27,154 nodes, including **23,153 cards, 1,978 dataflows and 287 alerts**. This is the best
    available answer to "what breaks if this goes away", and it is far richer than the governance
    `Total Impact` column.
  - No flags returns a mixed, smaller graph (3,382 nodes) that is neither one thing nor the other.

  **Neither direction gives the *immediate* parent.** The upstream call returns the entire ancestor
  tree, so it cannot tell you which dataflow actually writes the dataset. For that single edge use
  `GOLD \| MajorDomo \| DataFlows by Output DataSet`.
- **`GET /projects/v1/{id}` 404s for projects that provably exist.** The working paths are
  `GET /content/v2/users/{userId}/projects` and
  `GET /content/v1/projects/{projectId}/tasks?assignedToOwnerId={userId}`.
- **Archived governance datasets return HTTP 410**, not empty. Fall back to the live API.

## Lineage cannot see whole classes of dependency. Always cross-check the governance DataSets table

`GET /data/v1/lineage/DATA_SOURCE/{id}?traverseUp=false` only returns `CARD`, `DATAFLOW`, `ALERT` and
`DATA_SOURCE` nodes. **Everything else that can depend on a dataset is invisible to it**, so "no
downstream consumers" from lineage alone is not a safe basis for deletion.

Cross-check every delete candidate against `GOLD \| MajorDomo \| DataSets`, which carries a column per
dependency type: `Workflows`, `Code Engine Packages`, `Jupyter Workspaces`, `Toolkit Jobs`,
`Workspaces`, `DataSet Views`, `Impacted DataSets`, `PDP`, `Dependent Streams`, plus the card, alert
and dataflow counts.

On one account, 25 of 230 datasets that lineage called consumer-free had a dependency it could not
see: **14 `DataSet Views`, 14 `Impacted DataSets`, 12 `PDP` policies and 1 `Jupyter Workspace`**. A
`DataSet View` is a live child dataset that breaks when its parent goes, and a `PDP` count means
row-level security is configured on the dataset, so deleting it silently discards that policy.

Two cautions when reading those columns:

- **Check `Impact Updated Timestamp` per row.** It ranges from 2019 to the current day in the same
  table. Stale rows report cards and alerts that were deleted long ago; on one check every one of the
  8 biggest `Cards` claims resolved to zero live cards.
- **There is no working endpoint to resolve a view back to its children.** `/data/v3/datasources/{id}/views`,
  `/data/v1/datasources/{id}/views` and `/query/v1/views?dataSourceId=` all fail, and `Parent ID` in
  the governance table is a different relationship. Treat a non-zero `DataSet Views` as a hold signal
  rather than trying to enumerate the children.

## Candidate owners must be filtered for ACTIVE, not just excluded-actor

Verifying that a *chosen* destination is live is not enough. **Filter the candidate pool for active
users before ranking it**, or the "most active user" is often someone who has left.

On one account, 16 of 57 candidate viewers were deactivated, and they dominated the top of the list:
the busiest viewer of a 352-event app had 350 of those events and was deactivated, so the app had no
living user at all. Ranking without the filter produced a decision list where a third of the
recommended owners could not receive anything.

Two independent signals, and you need both:

- `active === false` on `GET /content/v2/users/{id}`
- `emailAddress` containing `_deleted_` (a deactivated account keeps a mangled address such as
  `name@domo.com_deleted_1759772994949`, and some of these still report `active: true`)

A useful by-product: containers whose only viewers are deactivated are **effectively dead** even
though they show recent events. Treat "live but every viewer has left" as its own bucket rather than
folding it into either live or dead, because it usually means the content retired with its audience.

## Verifying a delete: endpoints that return 200 for deleted objects

Getting these wrong makes a successful run look like a failure, or worse, a failed one look fine.
**Check the right field, not just whether the call succeeded.**

| Object | After deletion | Correct liveness test |
|---|---|---|
| DataFlow | **200 with `deleted: true`**, and `enabled` is still `true` | `deleted !== true`. `enabled` is meaningless on a deleted dataflow |
| Page | 404 | response has `pageId` |
| App Studio app | 404 | response has `dataAppId` |
| Card | absent from the `urns=` array | id present in the returned array |
| DataSet | 404 | response has `id` |

**Pages return `pageId` and apps return `dataAppId`, not `id`.** Testing `if (res.id)` reports every
live page and app as deleted. In one run that produced "0 of 37 held pages survived" when 33 were
alive and well, which looked like catastrophic collateral damage until the check was corrected.
Dataflows fail the opposite way: `if (res.id)` reports every deleted dataflow as still alive.

## Pagination and batching

- **`objectType=CARD,PAGE` on `/audit/v1/user-audits` returns zero rows, no error. SILENT.** One object type per call.
- **`POST /query/v1/functions/search` sorted by `name` is not stable. SILENT.** Beast-mode names repeat heavily, so rows with equal keys reorder between pages: one harvest returned exactly `totalHits` 2,745 rows but only **2,742 distinct ids**, with 3 duplicated and 3 missed. Count-matching hides it completely. **Dedupe by id while paging, and loop the whole find-resolve-act pass until an owner search returns zero.** The same instability makes destination-side counts unreliable, so verify per item. `bulk-transfer-ownership`'s discovery path had this bug (plain `offset += limit`, no dedupe) and was fixed 2026-08-21 to dedupe by id and repeat the pass until the owner search comes back empty.
- **Card `adminsummary` caps `limit` at 100**; 200 returns 400.
- The audit endpoint carries ~150 s fixed latency per call and tolerates ~8 concurrent requests.
- Deep pagination against the card search index errors out. Walk the owner list once instead of paging by offset.

## Write endpoints with surprising contracts

- **Beast modes: `{id, owner}` alone returns HTTP 500.** `POST /query/v1/functions/bulk/template` needs the links array too:
  ```
  {"update":[{"id":<fid>,"owner":<userId>,"links":<links from GET /query/v1/functions/template/{id}?hidden=true>}]}
  ```
  Echoing links back exactly as the server holds them changes only `owner` and leaves expression, `checkSum`, `legacyId` and status untouched.
- **Beast-mode transfer can fail transiently with `"Function links cannot be updated using the update
  template endpoint"` (HTTP 400).** In one run 1 of 394 hit this. The formula was untouched and still
  owned by the source. **Re-reading the template and retrying with freshly-read links succeeded**, with
  only `owner` changed and all links preserved, so treat this as transient and retry rather than
  concluding the links payload is malformed or pruning links to get past it. A batch containing one
  such row fails as a whole, so the per-item fallback is what saves the other 49.
- **A beast mode cannot be owned by a group, and neither can a dataflow.** `bulk-transfer-ownership`
  treating beast modes as user-only and skipping them when the destination is a group is therefore
  correct, not a limitation. This matters for routing: the dataset-owner rule breaks down whenever
  the linked dataset is group-owned. There is a deterministic cascade for that case
  (dataflow owner, then the departing user's manager if they are in the group, then the group member
  owning the most beast modes) documented under **When the linked dataset is group-owned** in
  `object-types.md`. Note that **card-owner corroboration is usually useless here**: in one run 14 of
  the 16 affected beast modes had exactly one card link and that card belonged to the departing
  account itself, so the corroboration was circular.
- **`bulk-transfer-ownership` no longer prunes beast-mode links by default (fixed 2026-08-21).** It used to call `processFunctionTemplate` on every transfer, which *deletes* a formula when all its links are invalid or a **visible** link is invalid, and it printed nothing when it did. The delete path is now behind `--prune-invalid-functions`; the default echoes the links back untouched so only `owner` moves. If you are on an older checkout, or you pass that flag, replay the formulas through the same logic first (existence of each `resource.id`, then `invalid.some(l => l.visible)`) and confirm the count that would be destroyed is zero.
- **A beast-mode dry run used to report 0 transferred (fixed 2026-08-21).** `transferFunctions` returned `{transferred: filteredIds}` on a dry run while the caller read `res.beastModes`, so the preview said 0 for work the real run would do in full. If a dry run reports 0 beast modes on an older checkout, that is the bug, not the plan.
- **The AppDB collection transfer endpoint is named `disableSyncToDataset`.** `PUT /datastores/v1/collections/{id}` with `{id, owner}` transfers ownership, but the operation name and its `schema` body field suggest it wipes the schema or breaks the dataset sync. It does neither; test it on an unsynced collection and then a low-risk synced one before touching anything that matters.
- **App instance transfer replaces the whole object.** `PUT /apps/v1/instances/{id}` needs the full body with `owner` swapped, or the mappings are lost. Diff every mapping afterwards (`datasetsMapping`, `collectionsMapping`, `databasesMapping`, `accountsMapping`, `actionsMapping`, `workflowsMapping`, `packagesMapping`) plus `disabled` and `designId`.
- **Datastore ownership cannot be changed. SILENT.** `PUT /datastores/v1/{id}` accepts an owner field, returns 200, and ignores it. The documented `updateDatastore` body only takes `name`. Whether deleting the user cascades into its datastores is unresolved and worth confirming with Domo, since it would take the collections with it.
- **App design ownership needs a purpose-built endpoint that may not be deployed.**
  ```
  PUT /api/apps/v1/designs/{designId}/transfer-owner   {"newOwner": "<userId>"}
  ```
  Optional `?parts=owners,creator`. It grants `READ_WRITE_DELETE_SHARE_ADMIN` to the new owner first and only then revokes it from the old one, so the last-owner guard never trips, and it writes an audit record. Auth is APP_ADMIN authority or ADMIN permission on the design. As of 2026-08 it **404s on `domo.domo.com`** for every path variant, with Spring's `No static resource ... for request` body, while sibling sub-paths (`.../has-thumbnail`, `.../versions`) return 200. Re-test after a release rather than reaching for a workaround. `updateDesign` only accepts `name` and `description`; the CLI's fallback is `POST /apps/v1/designs/{id}/permissions/ADMIN` with `[toUserId]`, which grants management rights but leaves `owner` alone.

## Object model surprises

- **An App Studio page is also a page record.** `GET /content/v1/pages/{viewId}` returns **200 with `owners: []`**, because ownership lives on the *app*. Resolving owners by calling the pages endpoint and only falling back to apps on a 404 therefore reports "ownerless page" for every app view. **Fall back whenever a page yields no owners**, looking the id up in the app-view map built from `GET /content/v1/dataapps/{appId}` → `views[].viewId`, walked recursively through `children`.
- **App Studio apps never emit a `VIEWED` event.** `DATA_APP` only logs `UPDATED` and `SHARED`, so checking usage at the app level returns zero for every app in the instance. Usage lives on the app's pages, object type **`DATA_APP_VIEW`** ("App page"), keyed by each view's `viewId`.
- **An AppDB `datastoreId` is an app id**, and there are two kinds: `GET /apps/v1/instances/{id}` (an app *instance*, carrying `designId`, `designVersion` and `collectionsMapping`) or `GET /apps/v1/designs/{id}` (an older design-scoped datastore). `collectionsMapping` is the authoritative list of collection ids the app binds *today*; a collection in a live app's datastore but absent from that mapping is a leftover from an earlier version.
- **A card's `Custom App ID` holds the app *instance* id, not the design id.** Matching design ids against it finds nothing. To go design → cards, resolve every instance id on cards and join on `designId`.
- **An AppDB collection has three independent owners**: the collection, the app instance, and the datastore record. Moving one does not move the others.
- **Account owners are not the `userId` field.** `GET /data/v1/accounts/{id}` exposes a single `userId`, the primary owner only. The real list is `GET /data/v2/accounts/share/{id}`, where owners are entries with `accessLevel: "OWNER"` and **can be groups as well as users**.
- **Public embeds:** the embed's owner is the `linkOwner`; the content's owner is the `cardOwner`. `linkOwnerIds` filters, but combining it with `cardOwnerIds` returns nothing.
- **`GET /apps/v1/instances` and `POST /apps/v1/instances/query` both 405.** There is no way to list app instances; enumerate via collection `datastoreId` plus every card's `Custom App ID`, and note that an instance with neither is invisible to both (though unreachable, so inert).

## Payload shapes that silently read as empty

Each of these parses to `undefined` rather than erroring, and `undefined` then reads as a benign
zero, so the wrong answer looks like a clean answer.

- **Beast-mode template links nest the type at `resource.type`**, not `entityType`:
  `{resource: {type: 'DATA_SOURCE', id: '...'}, visible, active, valid}`. Reading `entityType`
  reported "0 of 28 beast modes have a DATA_SOURCE link" when all 28 had exactly one.
- **Project payloads use `projectName`, `creator`, `assignedTo`, `members`; tasks use `taskName`,
  `status`, `archived`, `primaryTaskOwner`, `owners`.** There is no `name` and no `completed`.
  Reading `completed` yields `undefined`, which counts as "not completed", so every task reports
  as open.
- **A beast mode's `valid: "INCOMPATIBLE_LINK"` is not the same question as "does the resource
  exist".** 22 of 28 formulas carried an `INCOMPATIBLE_LINK` `DATA_SOURCE` link while every linked
  resource resolved fine. Judge deletability on existence, not on this flag.

## Environment

- **Yarn PnP:** `dotenv` and other deps are not resolvable from a script outside the repo. Parse `.env` by hand in scratchpad scripts, or run from the repo root.
- **`git.empdev.domo.com` is SAML-gated** and `gh` holds no PAT for that host. Fetch internal swagger through an authenticated browser session rather than running `gh auth login`.
- Public-embed transfer endpoints are absent from the bundled `openapi.json` and live only in the internal **apiContent** swagger.
- Rate-limit loops to 100-200 ms between calls, and retry 429/5xx with backoff.
