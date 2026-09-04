# Per-object-type mechanics

For each type: how to enumerate what the target owns authoritatively, how to move it, how to delete
it, and where the routing evidence comes from. `bulk-transfer-ownership` covers many of these; the
column says whether it does.

## Content

| Type | Authoritative owner list | In CLI? |
|---|---|---|
| Card | search index `owned_by_id`, **cross-checked against `GOLD \| MajorDomo \| Cards`.`Owner ID`**, then confirmed per card with `GET /content/v1/cards?urns=...&parts=owners`. **Not `cards/adminsummary`**, whose owner filter is silently ignored (see traps). The two enumeration sources agreeing on the same id set is the check worth doing: on one account both returned exactly 80 | yes |
| Dashboard (page) | `POST /content/v1/pages/adminsummary` | yes |
| App Studio app | `GET /content/v1/dataapps/{id}` → `owners`. **Not** `/adminsummary`, whose `access` field is users-with-access, not owners | yes |
| Group | `GET /content/v2/groups/grouplist?owner={userId}` | yes |

Ownership removal payloads that are known to work:

```js
// cards
api.post(`/content/v1/cards/owners/${action}`, { cardIds, cardOwners: [{ id, type }], note: '', sendEmail: false })
// pages
api.post('/content/v1/pages/bulk/owners/remove', { owners: [{ id: parseInt(fromUserId, 10), type: 'USER' }], pageIds })
// app studio
api.post('/content/v1/dataapps/bulk/owners/remove', { entityIds, owners: [{ type: 'USER', id: fromUserId }] })
// groups
api.put('/content/v2/groups/access', groupIds.map(gid => ({ groupId: gid, addOwners: [...], removeOwners: [{ type: 'USER', id: fromUserId }] })))
```

**Routing evidence.** Card usage comes from `Card` activity plus the traffic of every container the
card sits on. App Studio usage comes from `App Studio Page` keyed by `viewId`, never from the app.
Negative page ids are pseudo-pages (`-100002` is "Shared") and **must not count as a container**: a
card whose only page is "Shared" has no container owner to inherit it, and the pseudo-page's own
traffic is instance-wide noise, not evidence about that card.

Containers come from `RAW \| MajorDomo \| Cards by Page`, whose `pageType` separates `PAGE` from
`APP_PAGE`. `GET /content/v1/cards?urns=...&parts=pages` returns `[]` for every card, so a
containerless result there means nothing.

Where a card sits on several live containers, routing to the owner of the **highest-traffic**
container is defensible and easy to audit, but record every live container in the output so a
reviewer can see the ones that were not chosen. Also check whether a container's traffic is only its
own owner: "11 views by Casey Morgan alone" and "1,193 views by 28 people" both justify a transfer,
but they deserve different levels of confidence, and the thin ones are worth naming explicitly.

**Deleting a page CASCADES to its sub-pages. This is the most damaging trap in the whole process.**
`DELETE /content/v1/pages/{id}` silently takes every descendant page with it. In one run, deleting
130 pages destroyed **8 additional pages that had been deliberately excluded**, including two with
live third-party traffic that were awaiting a named owner and one carrying a live `Public` embed URL.
There is **no restore path**: `/restore`, `/undelete`, `?includeDeleted=true` and `/versions` all
404, and `POST /content/v1/pages/restore` is 405. Only Domo Support may be able to recover a page.

Before deleting any page, resolve the hierarchy and treat a parent as undeletable if **any**
descendant is being kept:

```sql
-- GOLD | MajorDomo | Pages carries the edges you need
SELECT `Page ID`, `Page Name`, `Parent Page ID`, `Grandparent Page ID`, `Owner ID`
FROM table WHERE `Parent Page ID` IN (<delete list>) OR `Grandparent Page ID` IN (<delete list>)
```

Any returned page that is *not* itself in the delete list is collateral. Either add it to the plan
deliberately or **remove its ancestor from the plan**. Note the dataset only exposes parent and
grandparent, so for deeper trees you have to walk it iteratively until no new descendants appear.

Two related mistakes from the same run:

- **Holding a page but deleting its cards is not a hold.** A page kept because it has an external
  embed still ends up empty, and the embed still breaks, if its cards are in the card delete list.
  Propagate a hold on a container to everything the container displays.
- **Cards survive their page.** Every card on those 8 pages that was not itself in the delete list
  still existed afterwards (109 of them). That is the one thing that makes this recoverable: the
  dashboards have to be rebuilt by hand, but the content is intact. Capture card-to-page mappings
  *before* deleting so a rebuild list exists.

**Resolving the container's owner.** Resolve the page, and **whenever it returns no owners, look the id up in the app-view map** (`GET /content/v1/dataapps/{appId}` → `views[].viewId`, walked recursively through `children`) and use the app's owners. An App Studio page returns 200 with `owners: []`, so a 404-only fallback misses every one.

## Beast modes and variables

- **Enumerate:** `POST /query/v1/functions/search` with `filters: [{ field: 'owner', idList: [userId] }]`. `global: false` is a beast mode, `true` is a variable. **Dedupe by id and loop until zero** (see the pagination trap).
- **Transfer:** `POST /query/v1/functions/bulk/template` with `{update: [{id, owner, links}]}`, chunks of 100. Links must come from `GET /query/v1/functions/template/{id}?hidden=true`, echoed back **exactly** so only `owner` moves. `bulk-transfer-ownership` now does this by default and only prunes links under `--prune-invalid-functions`; verify per item afterwards (`--verify`) that the formula still exists with its links, expression and status intact.
- **Routing:** every beast mode has exactly one `DATA_SOURCE` link, so **the dataset owner is the destination**. Card links are corroboration only: in one run 2,147 of 2,745 had a single card owner matching the dataset owner, and the 558 that differed did so because the beast mode is used on cards owned by several people, where no single card owner exists to pick.

### When the linked dataset is group-owned

**A group cannot own a beast mode**, so the dataset-owner rule yields no valid destination. Do not
send these to review; apply this cascade, in order, and record which rule fired:

1. **Is the dataset a dataflow output? Use the dataflow's owner.** Dataflows also cannot be
   group-owned, so this always lands on a real user. Resolve the producing dataflow with
   `GOLD | MajorDomo | DataFlows by Output DataSet` (`c3d97e68-0df7-4f16-ae31-ef80213b5827`), which
   carries `DataFlow ID`, `DataFlow Owner ID/Name/Type/Active` per output dataset. **Do not use
   `GET /data/v1/lineage/DATA_SOURCE/{id}`** for this: `traverseDown=false` is the correct direction
   (ancestors) but returns the entire upstream tree, hundreds of dataflows, never the immediate
   parent. See the traps file for what each traversal flag actually returns. The dataset's own
   `transportType: "DATAFLOW"` / `dataProviderType: "dataflow"` confirms it is an output but does not
   name the dataflow.
2. **Else, if the departing user's manager is a member of the owning group, use the manager.** Read
   `Reports To ID` / `HRIS Manager Domo ID` from `GOLD | MajorDomo | Users (People)`
   (`87276a1f-12ff-4008-904f-874966e618fa`); these are not exposed on `/content/v2/users/{id}` or
   `/identity/v1/users/{id}`. Expect them to be **blank for terminated accounts and integration
   users**, in which case this rule cannot fire.
3. **Else, use the active group member who owns the most beast modes.** Count per member with
   `POST /query/v1/functions/search` filtered by `owner`, deduping by id and looping until a pass
   returns nothing new (the sort is unstable, see the traps file), and count only `global: false`.

In one run this resolved all 16 affected beast modes with no human decision needed: 15 by rule 1
across 5 dataflows, 1 by rule 3. Rule 1 also cross-checked well, since two of the five dataflow
owners were themselves members of the group that owned the dataset.

## DataFlows

Single-owner, and **a dataflow cannot be owned by a group** (same as beast modes). Enumerate from the
search index (`entityList: [["dataflow"]]`) cross-checked against `GOLD | MajorDomo | DataFlows`.

**Do not expect activity to tell you who owns a pipeline.** On one account, widening to a **365-day**
window still found third-party activity on only 6 of 130 dataflows, and every actor was an
already-deleted user. `Modified By` on the governance table fails the same way: it is dominated by
whoever left most recently. Pipelines are infrastructure, so nobody touches them for years.

Use the data graph instead, in this order:

1. **Consumer majority.** Aggregate the owners of live cards downstream of the dataflow's outputs
   (per output dataset via `?traverseUp=false`, then resolve card owners live). Route only when one
   owner holds **>= 50%**. A plurality across many owners means shared infrastructure with no natural
   owner, and routing on it silently makes one person responsible for everyone's plumbing.
2. **Input dataset owner.** The most productive rule in practice: on one account **38 of 48 routed
   dataflows had a *sole* third-party input owner**, the rest a majority, no pluralities. Get the
   edges from `GOLD | MajorDomo | DataFlows by Input DataSet`, which carries
   `Input DataSet Owner ID/Name/Type/Active` directly.
3. **Group tie-break.** If a rule lands on a group, fall through to the group member owning the most
   dataflows.

**Sort the unrouteable remainder before asking a human about it.** Split by whether anything
downstream consumes the outputs at all (cards *or* other dataflows). On one account that turned a
68-item queue into 43 **terminal** dataflows with no consumers of any kind (**42 of them still
enabled and running**, one with 497 runs), 8 feeding only other dataflows from the same estate, and
just 12 that genuinely needed a named owner. Terminal pipelines are pause-or-delete candidates, not
transfer candidates, and they are usually worth reporting on their own as wasted compute.

**Sequencing note.** Transferring dataflows first is what makes their output datasets routeable, since
an output dataset inherits its dataflow's new owner. It is only a partial unlock: outputs of an
unrouteable dataflow stay unrouteable, so expect to resolve roughly the same fraction of datasets as
dataflows.

## Connection accounts

- **Enumerate:** search index, `entityList: [["account"]]`, `term` filter on `owned_by_id`. Not `GET /data/v1/accounts`.
- **Owners:** `GET /data/v2/accounts/share/{id}` → entries with `accessLevel: "OWNER"`; can be groups.
- **Remove an owner:** `PUT /data/v2/accounts/share/{id}` with `{"type":"USER","id":<userId>,"accessLevel":"NONE"}`. Safe on accounts with live pipelines, because a stream authenticates with the account credential, not the owner's identity.
- **Delete:** `DELETE /data/v1/accounts/{id}` (204).
- **Dependencies:** the governance Accounts dataset's `Direct Dependencies` column, cross-checked against the live `POST /data/v2/datasources/accounts` (body is an array of numeric ids; this is what the account drawer calls) and the stream-to-account edge in the governance Streams dataset. There is no live per-account dependency endpoint; `/data/v1/accounts/{id}/dependencies` and every variant 404s.
- Accounts on a **personal email** cannot be fixed by transfer. The credential belongs to a person and has to be recreated against a service identity.

## AppDB collections

- **Enumerate:** `POST /datastores/v1/collections/query` with `collectionFilteringList: [{filterType:'ownedby', comparingCriteria:'equals', typedValue:userId}]`, paged by `pageNumber`/`pageSize`.
- **Detail:** `GET /datastores/v1/collections/{id}` gives `datasourceId` (the synced dataset) and the column schema. `GET .../permission` gives grants, which are always exactly one `RYUU_APP`, its own datastore.
- **Transfer:** `PUT /datastores/v1/collections/{id}` with `{id, owner}`.
- **Delete:** `DELETE /datastores/v1/collections/{id}` (204).
- **Reachability, in order:** is the collection id in its app instance's `collectionsMapping`? does a card host that instance (`Custom App ID`)? has that card loaded? does its synced dataset still exist and have consumers (`GET /data/v1/lineage/DATA_SOURCE/{id}`)? Nothing on all counts means nothing can reach it.
- Document contents are usually unreadable (403; grants are the owning app plus MajorDomo), so content-based evidence is not available. `documentCount` is useless.
- **Beware `ddx_app_client_code`**: a DDX brick's client-side code store. It may be read at runtime by name rather than through `collectionsMapping`, so hold it when its app has a live card even if the mapping omits it.

## App instances

**Invisible to `bulk-list-user-content`.** Not in the CLI.

- **Enumerate** by union of two routes, because neither alone is sufficient:
  1. `datastoreId` on every AppDB collection.
  2. `Custom App ID` on every card (from the governance Cards dataset), resolved through `GET /apps/v1/instances/{id}` and filtered by `owner`. In one run this found an instance the collection route missed entirely.
  There is no listing endpoint (`GET /apps/v1/instances` and `POST /apps/v1/instances/query` both 405). An instance with neither a card nor collections is invisible to both, but unreachable, so inert.
- **Transfer:** `PUT /apps/v1/instances/{id}` with the **full body** and `owner` swapped, then diff every mapping.
- **Routing:** the owner of the card whose `Custom App ID` is this instance.

## App designs

- **Enumerate:** `GET /apps/v1/designs?checkAdminAuthority=true&deleted=false&limit=&offset=`, filtered by `owner`. Per-id lookups 404 for apps you do not own, so never use them to test existence.
- **Transfer:** `PUT /apps/v1/designs/{designId}/transfer-owner` with `{"newOwner": "<userId>"}` (no `/api` prefix through `lib/api.js`). Confirmed working 2026-09-01. `bulk-transfer-ownership --object-types custom-app --verify` now uses it; the old ADMIN-grant fallback does **not** move `owner` and is reported separately. See the traps file.
- **Routing:** resolve every instance id on cards, join on `designId`, and take the deploying card's owner. A design that no card deploys has no evidence-based destination and needs a named owner chosen by hand, or deleting.

## Datastore records

`GET /datastores/v1/{id}`. **Ownership cannot be transferred** (see traps). Report them as a residual and confirm the deletion-cascade behaviour with Domo before deleting the user.

## Public embeds

Terminology: the embed's owner is the `linkOwner`, the content's owner is the `cardOwner`. `embedViewIds` are numeric embed ids, not gateway tokens.

List with `POST .../embed/summary?limit=&offset=` and `{"linkOwnerIds":[<userId>]}` against three
resources that **do not overlap**:

| Embed on | List | Transfer with |
|---|---|---|
| Card | `POST /content/v1/cards/kpi/embed/summary` | `PUT /content/v1/cards/kpi/embed/owners` |
| Page | `POST /content/v1/pages/embed/summary` | `PUT /content/v1/pages/embed/owners` |
| App Studio app | `POST /content/v1/dataapps/embed/summary` | **the pages endpoint** (no app variant exists) |

Transfer body: `{"embedViewIds":[<embedId>...], "ownerId":<userId>}`. These live in the internal
**apiContent** swagger, not the bundled `openapi.json`. After transferring, confirm gateway tokens
and link types are unchanged so no public URL breaks.

Check external exposure before deleting anything: an app that looks marginal on in-app views can
have a large external audience (one had 5 in-app views and 158 external).

## Types `bulk-list-user-content` does not report

Found by sweeping `Object Owner ID` in the governance Activity Log. None of these is a normal asset,
but they change what "clean" means and one of them mails people.

| Type | How it shows up | What to do |
|---|---|---|
| Approval | `Approval` rows, often named after the person ("Quarterly No Side Agreement Certification: X") | Not a transferable asset. Let an in-flight one close or cancel it |
| Queue task | `Queue Task` rows with ids like `07OCT25_HKG1H4` | Single-owner; no transfer path exercised yet |
| Workflow execution | `Workflow Execution` rows | Execution records, not assets |

Also note the inventory's `PROJECT` and `PROJECT_TASK` rows are **participation and assignment, not
ownership**: `/content/v2/users/{id}/projects` includes projects the user is merely a member of, and
project-task rows come from `?assignedToOwnerId=`. Check `creator` on each project before treating it
as the user's own.

## Single-owner types needing outright transfer

Jupyter workspaces, Code Engine packages, workflows, projects, queues and tasks have one owner, so
"remove the owner" is not available and they need a real transfer. Not yet exercised in a run.
