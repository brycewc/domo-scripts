---
name: decommission-domo-user
description: Retire a Domo user by working out what they still own, proving what is actually used, then transferring or deleting each object. Use when the user wants to offboard, decommission, retire, clean up, or delete a Domo user or service/integration account, asks "what does user X still own", "is anything using these cards/pages/apps", "who should inherit this", or wants ownership moved off an account before deleting it. Covers the evidence rules, the per-object-type transfer and delete mechanics, and the API traps that silently produce wrong answers.
references:
  - references/api-traps.md
  - references/object-types.md
  - references/governance-datasets.md
  - scripts/harvest-activity.js
---

# Decommissioning a Domo user

The job is not "delete everything this account owns". It is: **prove what is still used, hand that to whoever actually uses it, and delete only what nothing can reach.** Deletions are irreversible and usually hit content other people can see, so every verdict has to rest on attributed evidence, not on metadata timestamps or plausible-looking counters.

Work in this order. Do not skip to executing.

## 1. Agree the evidence rules before analysing anything

Confirm these with the user up front, because they change every downstream verdict:

- **Who does not count as a user.** Always exclude the operator running the cleanup, the target account itself, and Domo's **MajorDomo service account** (id `1486980888` on `domo.domo.com`; match on name `/majordomo/i` elsewhere). MajorDomo performs owner churn and reshares that look exactly like engagement, and it will revive dead objects if you let it.
- **The window.** Default to **180 days for anything facing deletion.** 90 days misreads a dashboard that gets opened once a quarter. In one run, widening the window rescued 6 of 223 in the first delete pass and 17 of 294 in the second.
- **Who inherits.** The default routing rule is *the owner of the container the object lives in*: a card goes to the owner of its dashboard, page or App Studio app; a beast mode to the owner of its dataset; an AppDB collection or app instance to the owner of the card that hosts it. Ask before routing anything to a placeholder or service account, which just recreates the problem one step removed.

- **Whether the account is actually headless.** Do not take the name for it. Group the target's own
  activity by `Action Name`, `Device` and `Authentication Method` (governance Activity Log,
  `User ID` = target). An account called "Integration User" turned out to have 179 SSO sign-ins from
  desktop and mobile and was creating and sharing cards by hand, which means no external system
  breaks on deletion but the compliance approvals addressed to that person are real. The opposite
  case — genuine token traffic — means deleting the account breaks a pipeline, so establish which
  one you have before promising anything. The date its activity stops is usually the departure date
  and a good sanity check on the window.

Write the agreed rules at the top of the run's README so every later verdict is auditable.

## 2. Inventory, and distrust the count

```bash
node cli.js bulk-list-user-content --id <userId> --format csv --output logs/cleanup-<userId>/inventory.csv
```

**`bulk-list-user-content` counts ownership reached through group membership**, and for projects it
counts participation and assignment rather than ownership. A non-zero row count does not mean direct
ownership. Before acting on any type, re-check against the authoritative per-type owner source (see
[references/object-types.md](references/object-types.md)); rows that are only transitive clear by
themselves when the user is deleted, and chasing them wastes a lot of effort. Note the authoritative
source for **cards is not `adminsummary`** — its owner filter is silently ignored.

The inventory also **under**-reports. **App instances** and **datastore records** are invisible to it
and must be enumerated separately; **report schedules, approvals, queue tasks and workflow
executions** never appear either. Sweep `Object Owner ID` in the governance Activity Log to find
them, then verify each live. A report schedule owned by a dormant account keeps emailing people and
is the one of these that actually does something.

## 3. Harvest evidence

**Try `GOLD | MajorDomo | Activity Log` first** (`0b09a9d5-0e59-4650-9626-083349d0c419` on
`domo.domo.com`). It is event-level, attributed, fresh to the current hour, reaches back to 2018, and
covers every type these runs care about. One SQL query per object type replaces the whole audit-log
sweep: seconds instead of ~3 hours, and because it predates the window you can tell "quiet lately"
from "never logged", which a windowed sweep cannot. Its `Object Owner ID` column also catches the
types the inventory misses. Query shapes, exclusion ids and the gotchas are in
[references/governance-datasets.md](references/governance-datasets.md).

Fall back to the bundled harvester when that dataset is absent, archived (HTTP 410) or does not cover
the type. It encodes the three things that are easy to get wrong against the raw audit API:

```bash
node .claude/skills/decommission-domo-user/scripts/harvest-activity.js \
  --target <userId> --days 180 --types CARD,PAGE,DATA_APP_VIEW \
  --exclude <yourUserId> --out logs/cleanup-<userId>
```

It writes `activity_<TYPE>.json` per type, keyed by object id, with `views`, `engaged` (deliberate
actions), `viewers`, `lastView` and `lastEngaged`. Failed day-chunks are written to a companion file:
**re-run those before trusting any zero**, since a missing chunk looks exactly like inactivity.

What it encodes, from `GET /audit/v1/user-audits` (`start`, `end`, `objectType`, `limit`, `offset`):

- **One `objectType` per call.** `objectType=CARD,PAGE` returns zero rows and no error.
- The endpoint carries roughly 150 s of fixed latency per call but tolerates ~8 concurrent requests. Day-chunk the window and use a worker pool; this is the difference between a 10-hour sweep and a 36-minute one.
- A row's timestamp is `time` (epoch ms) and its event is `actionType`; the actor is `userId`/`userName`, not `actorId`, which is 0 for ordinary activity.
- Object types that matter: `CARD`, `PAGE`, `DATA_APP_VIEW` (App Studio pages), `PUBLIC_URL`, `GROUP`, `BEAST_MODE_FORMULA`.

For several types the audit log is the wrong source and a MajorDomo governance dataset is both cheaper and more complete. See [references/governance-datasets.md](references/governance-datasets.md).

Then join each object to its container so it inherits the container's traffic. A card with no card-level views is still in use if its dashboard is loaded; in one run 181 of 194 transfers were justified by dashboard traffic rather than the card's own.

## 4. Bucket, then apply the co-ownership rule first

Standard buckets: **transfer** (in use), **review** (judgment call), **needs sign-off** (dead but sitting on someone else's container), **delete** (dead and reachable by nobody).

Apply co-ownership before anything else, because it removes most of the work:

- **Co-owned with anyone else → just remove the target as an owner and leave every other owner in place.** No transfer, no cleanup. The object keeps working.
- **Exception:** if it is in the definitive-delete bucket, delete it instead.
- Never leave an object ownerless. Verify remaining owners after each removal.

For the rest:

- **Dead card on someone else's container** → only delete once the *container* has also been checked over the full window and found dead. Re-verify at the 180-day mark right before executing, not from the earlier 90-day pass.
- **Review bucket** → prefer transferring to the container's owner over deleting.

## 5. Execute with pre-flight, invariants and verification

Every irreversible batch follows the same shape:

1. **Re-derive state at execution time.** Ownership and containment change between analysis and execution. Re-read each object immediately before acting on it.
2. **Assert hard invariants and refuse to proceed if any fails.** Real examples that caught real problems: "0 delete-list objects have any third-party activity", "0 delete-list collections are bound by a live app", "the set still owned by the account matches the delete plan exactly, with no drift".
3. **Batch with per-item fallback.** When a bulk call fails, retry the batch one item at a time so one bad row does not sink 99 good ones.
4. **Verify on both sides, per object, against the live API.** Confirm the object left the source *and* arrived at the destination, and that nothing else changed. For ownership transfers, diff the full object before and after and assert only `owner` moved. **Re-running `bulk-list-user-content` is not verification:** the card search index lags ownership writes and reported 13 cards still owned by the source when only 2 remained. `bulk-transfer-ownership --verify` does this per object for card, page, app-studio, beast-mode, variable, dataset and dataflow, and reports anything left ownerless or unmoved.
5. **Confirm the destination is live** before sending anything to it.

Prefer `node cli.js bulk-transfer-ownership` where it covers the type. It takes **per-row
destinations** via `--to-owner-column`, which handles container-owner routing for cards, pages and
beast modes in a single run, so a throwaway script is only needed for types it does not cover. Add
`--verify` to any real run. Leave `--prune-invalid-functions` off unless link cleanup is genuinely
the goal: with it, a beast mode whose links are all dead, or whose visible link is dead, is
**deleted** rather than transferred.

## 6. Never trust a single source, and always run a control

This is the most important habit in this whole process. Several Domo fields and endpoints return confidently wrong answers, and each one is capable of justifying the deletion of live data:

- **Before treating a 404 as "deleted", look up an object you can independently prove exists.** `GET /apps/v1/designs/{id}` returns 404 for apps you do not own, which once produced "17 of 19 apps are deleted" when the true answer was 14 live.
- **Before treating a zero as "unused", check the field is populated at all.** AppDB `documentCount` is `0` for every collection in the instance. Same for `Embeds` on the governance Cards table: prove some object somewhere has a non-zero value before reading your target's `0` as "no public exposure".
- **Before treating an empty filter result as "owns none of these", run the same filter against someone who definitely owns some.** The account search returned 0 for one target and 97 for the operator, which is what made the 0 trustworthy. A filter that is silently ignored, like the one on `cards/adminsummary`, fails this test immediately.
- **Before parsing a payload, print one whole record.** Half the wrong answers in these runs came from reading a field name that does not exist (`entityType`, `completed`, `name`) and getting `undefined`, which then reads as a clean zero.
- **Require two fresh, independent sources to agree before deleting.** Where they disagree, find out why rather than picking one.

The full catalogue of traps found so far is in [references/api-traps.md](references/api-traps.md). **Read it before starting**: it is the accumulated cost of getting these wrong once.

## 7. Leave an auditable trail

Write everything to `logs/cleanup-<userId>/` (git-ignored) as one CSV per action, each row carrying the evidence behind its verdict, plus a `README.md` recording the rules, the method, the API traps hit, and what remains. Lettered files (`A-`, `B-`, ...) in execution order work well. Quarantine superseded lists in `superseded/` so nobody runs a plan that was built on the narrower window.

## What is usually left at the end

Content clears easily; these are the ones that actually break things and deserve the most care:

1. **Report schedules.** Invisible to the inventory, and they keep emailing people long after the
   person stops logging in. Find them in the Activity Log (`Report Schedule` / `Emailed`) and settle
   them before deleting the account.
2. **Connection accounts** with live dependencies and no second owner. The likeliest silent breakage on user deletion. Route dependency questions through the governance Accounts dataset, and treat accounts on a personal email as unfixable by transfer, since the credential itself belongs to a person.
3. **Datastore records**, which cannot be transferred at all.
4. **App designs**, which need a purpose-built endpoint that may not be deployed on your instance.
5. **Single-owner types** (Jupyter workspaces, Code Engine packages, workflows) that need an outright transfer rather than an ownership removal.
