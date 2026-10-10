# Drive sync contract (for the Desktop sync engine, apps and Spotlight)

Status: server side built in Phase 21B round 1. The Desktop sync engine (needs the 19A desktop
branch, PR #30) is NOT built here; this is the contract it codes against. Everything below is
tested server-side (`lib/drive/__tests__/*`); real-disk behaviour is for the desktop branch.

## The model in one picture

```
/home/<userId>/…            private to that person (files.ownerUserId = userId)
/shared/…                   the workspace's folders (ownerUserId = null)
  /shared/{skills,memory,artifacts,files}   the four system folders, STORED as /skills /memory
                            /artifacts /files, SHOWN under /shared (one canonical spelling:
                            /shared/files/x is /files/x)
/apps/<appId>/<install>/…   one app install's container (21C), own quota
/agents/<runId>/…           an agent run's workspace
/mounts/<provider>/…        a mounted outside source (only "google-drive")
/trash                      a VIEW over trashed rows, never a stored path
```

* Paths are NFC; names may not contain `< > : " / \ | ? *`, control or bidi characters, may not end
  in a dot or space, and Windows device names (`CON`, `NUL.txt`, …) are refused. Two names that
  differ only by case or Unicode form are the same name (`path_key`): the second is a conflict.
  Limits: 255 bytes per name, 1024 characters per path, 32 levels. Plan for Windows' 260-character
  limit on the client; the server does not.
* A private home is invisible to everyone else, admins and owners included, except through an
  explicit share (folder or file entry, view or edit, never ownership). There is no break-glass;
  that is a decision for the workspace owner.
* ACLs live on folders and are inherited; the nearest entry for a person wins (a file entry beats
  its folder, a deeper folder beats a shallower one), capped by their workspace role.

## The change feed

`GET /api/drive/changes?workspaceId=&cursor=&limit=` (viewer+) returns

```json
{ "changes": [ { "seq": "42", "cursor": "v1.42", "type": "create|update|move|trash|restore|delete",
                 "entity": "file|folder", "entityId": "…", "path": "/shared/a.txt",
                 "prevPath": null, "version": 3, "actorUserId": "…", "at": "2026-11-02T10:00:00.000Z" } ],
  "cursor": "v1.42", "head": "v1.57", "hasMore": true }
```

* **Order.** `seq` is a per-workspace sequence allocated inside the transaction of the write it
  describes, under a row lock. Commit order is sequence order: when you can see event N, every
  event below N is committed and visible. A client that stores the last `cursor` it applied can
  never miss an event. Events are idempotent to re-apply (they carry the state, not a delta).
* **Cursors** are opaque `v1.<seq>`. Omit it to start from the beginning. 400 `bad_cursor` for one
  we did not issue; 410 `cursor_expired` when it is older than the journal keeps — do a full
  listing and follow from `head`.
* **Initial sync.** 1) read `head` (`GET /api/drive/changes?limit=1`), 2) list the tree
  (`GET /api/drive/tree?view=list&path=…` per folder, paged), 3) follow changes from the `head` you
  read in step 1. Events that arrive for things the listing already showed are harmless.
* **Meaning of `type`.** `create` a new file/folder; `update` new bytes (a new version) or new
  metadata (tags, colour, sharing); `move` also covers rename (`prevPath` is set; a folder move
  sends one event for the folder and one per descendant); `trash` it left the live tree but is
  recoverable for 30 days; `restore` it came back; `delete` it was purged for good.
* **Privacy.** Your feed contains only what you may see. A move between your private home and the
  shared area appears as a create/delete on the shared side. Shares into someone's home do not
  appear in the sharee's feed — use `view=shared`.
* **Retention.** Events older than the retention window are purged (`purgeChangesBefore`) and the
  floor advances; plan for 410.

## Uploads

* Up to 25 MB: `POST /api/drive/upload` (multipart: `workspaceId`, `dir`, `file`, optional
  `relativePath`, `replace=1`).
* Larger (to 2 GiB − 1, quota-governed): `POST /api/drive/uploads` with `initiate` (returns
  `partSize`, `partCount`), `parts` (presigned PUT URLs, 15 minutes each, ask again to resume),
  `status` (asks the storage provider which parts it holds), `complete`, `abort`. Above 25 MB only
  images, PDFs and text files are accepted; the assembled object is scanned end to end. Local-disk
  storage answers `mode: "direct"` and keeps the 25 MB path.
* **Replacing a file** creates a new version; the old bytes are kept (the workspace's retention
  setting caps how many).
* **Conflicts.** The server never merges. A client that edited a file offline sends the version it
  started from and compares: if `GET /api/files/<id>` shows a newer `version`, keep both — upload
  the local copy as `name (conflicted copy).ext` — and let the person decide. (Server-enforced
  `baseVersion` is on the roadmap for round 2 of the desktop work.)
* Hashes: the server does not expose a content hash yet; clients compare `version` and size, and
  hash locally.

## Things the client must not assume

* Names are case-insensitive and NFC-normalised server-side; a name that differs only by case from
  an existing sibling is rejected with 409.
* The four system folders (`/shared/skills|memory|artifacts`) are managed by ShapesOS; files in
  them cannot be moved in or out.
* Agent proposals (`/agents/<run>/proposed/…`) are staged copies, not live files.
