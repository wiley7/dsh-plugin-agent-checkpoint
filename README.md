# dsh-plugin-agent-checkpoint

Session-aware task checkpoints for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

Most agent checkpoint tools snapshot **files**. That is only half of what a
coding session is: when you go back to an earlier milestone, the files come
back but the conversation — the plan, the decisions, the tool results that
justified the code — is gone, so the agent restarts from a blank slate.

`dsh-plugin-agent-checkpoint` binds both halves together:

- **files** — the exact working-tree state, addressed by a git tree object and
  (after confirmation) by a real commit hash;
- **agent context** — a serialized digest of the DSH session that produced that
  state: the task plan, the recent user/assistant messages and tool usage.

Rolling back restores the files *and* hands the agent a context digest so it
can continue from the milestone instead of re-discovering the task.

It ships as an MCP stdio server with nine tools, uses the system `git` binary
(no bundled git library), and never performs a destructive git operation
without a human-confirmed, single-use token.

It also ships a browser half: every finalized reply in the DSH web UI carries a
small badge with the commit the workspace is currently on
(`main 4e850e7`, `*` for uncommitted changes, `⚑` when that commit is a
confirmed checkpoint).

---

## Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 20 | developed on Node 26; the session reader prefers `node:zlib` zstd support and falls back to the `zstd` CLI |
| git | ≥ 2.23 recommended | `git switch` is used when available, `git checkout` otherwise |
| DSH | any build with `@deepseek-ai/dsh-mcp-client` | the commit badge additionally needs a web profile (the desktop or `web` app) |

`git` must be installed and on `PATH`; the plugin never installs it for you.

## Install

```bash
git clone <this repository> dsh-plugin-agent-checkpoint
cd dsh-plugin-agent-checkpoint
pnpm install
pnpm run build          # emits dist/
```

Verify the server starts:

```bash
node dist/index.js --help
```

## Register with DSH

The package has two halves and `cordis.patch.yml` mounts both:

| Half | Composited entry | What it does |
| --- | --- | --- |
| **MCP server** | `agent-checkpoint-mcp` → `@deepseek-ai/dsh-mcp-client` | the nine tools, spawned over stdio |
| **host plugin** | `agent-checkpoint` → `dsh-plugin-agent-checkpoint` | one loopback JSON route the browser badge reads |

A profile composes plugin *bundles*, and its user layer can only patch entries
that already exist, so installing this package as a bundle is the intended path.

### Option A — install as a bundle (recommended)

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-plugin-agent-checkpoint
```

(`add dsh-plugin-agent-checkpoint` instead, once it is published to npm.)

The package declares `dsh.bundle.patch`, so DSH appends it to
`dsh.profile.bundles` and applies `cordis.patch.yml` on the next boot. Restart
DSH: the tools appear as `mcp__agent-checkpoint__<tool>` and the badge appears
under every finalized assistant reply.

The workspace is resolved per request (see the badge section below); the MCP
server falls back to `$DSH_AGENT_CHECKPOINT_WORKSPACE`, then `$DSH_WORKSPACE`,
then the directory DSH was launched from. To pin both halves, export it before
launching:

```bash
export DSH_AGENT_CHECKPOINT_WORKSPACE=/absolute/path/to/your/project
```

or override the entries in the profile's own `cordis.patch.yml` (an override
*replaces* the whole `config` object, so repeat every key you need):

```yaml
- id: agent-checkpoint
  config:
    workspace: /absolute/path/to/your/project

- id: agent-checkpoint-mcp
  config:
    transport: stdio
    serverName: agent-checkpoint
    command: node
    args:
      - !!js decodeURIComponent(new URL('node_modules/dsh-plugin-agent-checkpoint/dist/index.js', baseUrl).pathname)
      - "--workspace"
      - /absolute/path/to/your/project
    cwd: /absolute/path/to/your/project
    toolCallTimeoutMs: 120000
    failOnStartupError: true
```

`baseUrl` inside `!!js` is the profile directory, so the first argument resolves
to the installed copy of the MCP server.

### Option B — insert the entries by hand

If you prefer not to install the package into the profile, append one `insert`
block with both entries to the profile's `cordis.patch.yml` (for the desktop
profile: `~/.dsh/profiles/desktop/cordis.patch.yml`):

```yaml
- insert:
    - id: agent-checkpoint
      name: dsh-plugin-agent-checkpoint
      config:
        workspace: /absolute/path/to/your/project
    - id: agent-checkpoint-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: stdio
        serverName: agent-checkpoint
        command: node
        args:
          - "/absolute/path/to/dsh-plugin-agent-checkpoint/dist/index.js"
          - "--workspace"
          - "/absolute/path/to/your/project"
        cwd: "/absolute/path/to/your/project"
        toolCallTimeoutMs: 120000
        failOnStartupError: true
```

A bare `- id: …` entry at the top level of that file does **not** work: patch
entries without `insert:` only override entries that already exist. Drop the
host entry if you only want the tools and no badge — the MCP half works on its
own (including in `headless` profiles, where no web server exists).

### Verifying the registration

```bash
dsh --profile web --dump-config | grep -A 12 agent-checkpoint
```

The composed entry list should contain both rows. If the MCP server fails to
start, DSH reports the spawn error at boot; run the server manually
(`node dist/index.js --workspace <project>`) to see its own diagnostics. For the
badge, open a conversation in the same profile and check the action strip under
any finished reply, or call the route directly:

```bash
curl -s 'http://127.0.0.1:<port>/api/agent-checkpoint/git' | head -c 400
```

## Commit badge in the web UI

Every finalized assistant message gets one quiet pill in its action strip:

```
⎇ main 4e850e7 *    ⚑
```

- `4e850e7` — short hash of the workspace HEAD; **click copies the full hash**,
  the tooltip carries branch, subject, commit time, checkpoint id and workspace.
- `*` — the workspace has uncommitted changes (so the badge never claims the
  files match the commit when they do not).
- `⚑` — that commit is a **confirmed checkpoint**; hover for its title. This is
  the visual link between the git history and the plugin's snapshot library.

### Where the numbers come from

The browser cannot read a repository, so the badge calls the plugin's own
same-origin route, served by the host half:

| Aspect | Behavior |
| --- | --- |
| Route | `GET /api/agent-checkpoint/git?session=<sessionId>&limit=<n>` |
| Access | loopback only (`127.0.0.0/8`, `::1`, `::ffff:` forms); anything else gets `403` |
| Methods | `GET` and `HEAD` only; `405` otherwise |
| Response | `{ ok, workspace, source, isRepo, branch, head, isDirty, commits[], capturedAt, error, warnings }` with `cache-control: no-store` |
| Workspace | `?workspace=` takes precedence, otherwise the **cwd of the session you are viewing** (read from its `session.v*.jsonl` header), then the entry config, `$DSH_WORKSPACE`, cwd |
| History | up to `limit` (default 50, max 500) recent commits, each annotated with the checkpoint that produced it |
| Writes | none — the route never commits, resets or stages; destructive work stays behind the MCP tools' confirmation tokens |
| Polling | 20 s per mounted badge, paused while the tab is hidden; one request is shared by every badge of the same session, and snapshots are memoized for 8 s |

The route is read-only on purpose: a UI that could move `HEAD` would make the
"no destructive operation without confirmation" guarantee meaningless.

The badge shows the workspace HEAD as of the last poll — it is a *current*
indicator, not a per-message provenance record. Attributing each reply to the
commit that was current when it was written needs the per-turn timeline that the
route already returns; that is a roadmap item, not a promise.

Entering a workspace that is not a git repository simply hides the badge (the
route answers `{ ok: false, error: "not_a_git_repo" }` once, and the client
stops polling a "show nothing" state).

### Badge configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `workspace` | auto-detected | fallback workspace when a request carries no `?session=` |
| `maxCommits` | `120` | server-side cap on the returned history; the badge asks for 50, requests clamp to 500 |

The browser half has no configuration: it is registered into the
`conversation.chat.assistant-actions` list slot with id `agent-checkpoint-commit`
and order `60`, so it coexists with the built-in feedback buttons instead of
competing for the single `turnTail` chain slot.

## CLI options

`node dist/index.js` runs the MCP server half (normally spawned by DSH; useful
standalone for debugging):

```
dsh-plugin-agent-checkpoint [options]

  -C, --workspace <path>     workspace (git repository root) to manage
                             (default: $DSH_WORKSPACE or the current directory)
      --session-file <path>  read agent context from an explicit DSH session log
  -v, --version              print the version and exit
  -h, --help                 print this help and exit
```

`--session-file` is a testing/automation escape hatch: normally the plugin
discovers the session log from `$DSH_HOME` and `$DSH_SESSION_ID` itself.

## Tools

All nine tools follow the requirement document. Tools marked **destructive**
require a two-phase confirmation (see [Safety rails](#safety-rails)).

| Tool | Arguments | Returns |
| --- | --- | --- |
| `init_workspace` | `workspace_path?` | repository state, whether it was created, ignore rules applied, next steps |
| `create_draft_checkpoint` | `title`, `tags[]?`, `remark?` | `draft_id`, changed files, diff summary, context summary |
| `preview_checkpoint` | `checkpoint_id`, `include_diff?`, `max_diff_chars?` | title, remark, tags, timestamps, file diff, context digest, bound commit hash (empty for drafts) |
| `confirm_checkpoint` **(destructive)** | `draft_id`, `commit_message`, `confirmation_id?` | first call: confirmation token + summary; second call: commit hash, confirmed checkpoint id |
| `list_checkpoints` | `tags_filter[]?`, `limit?`, `include_drafts?`, `query?` | newest-first checkpoint list |
| `rollback_checkpoint` **(destructive)** | `checkpoint_id`, `confirmation_id?` | first call: confirmation token + summary; second call: restored files, branch moved flag, context digest |
| `create_branch` | `branch_name`, `checkpoint_id?` | branch name, start point |
| `switch_branch` | `branch_name` | previous and current branch |
| `get_status` | — | working-tree changes, current branch, draft/confirmed counts, last checkpoint, pending confirmations |

Checkpoint ids are stable, human-readable strings such as
`draft-1792582824171-fb62938a`. Any unique fragment of an id is accepted; after
a draft is confirmed its original `draft-…` id keeps resolving to the confirmed
record.

## Typical flow

```
init_workspace                       # once per workspace
  └─ create_draft_checkpoint         # at a milestone (subtask finished)
       └─ preview_checkpoint         # operator reviews files + context
            └─ confirm_checkpoint    # operator approves → real git commit
                 └─ … more milestones …
                      └─ rollback_checkpoint   # go back to any milestone
```

`create_draft_checkpoint` deliberately **does not commit**. It captures the
working tree into a tree object, creates a dangling commit object for it and
anchors that object under `refs/dsh-checkpoint/drafts/<id>` so garbage
collection cannot prune it while the operator decides. `HEAD` and the branch
never move.

`confirm_checkpoint` turns a draft into a normal commit:

```
git add --all
git commit --no-verify -m "<commit_message>"
```

and records the resulting hash in the checkpoint store. It refuses (with a
conflict report, see below) when the repository moved since the draft.

## Configuration

Optional `checkpoint.config.json` in the workspace root. Missing fields fall
back to the defaults below; invalid values produce warnings but never abort a
tool call.

```json
{
  "auto_draft_on_milestone": true,
  "ignore_patterns": ["node_modules", ".venv", "dist", "build"],
  "max_draft_count": 10
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `auto_draft_on_milestone` | `true` | policy hint for the agent: draft at a milestone instead of every turn |
| `ignore_patterns` | `["node_modules", ".venv", "dist", "build"]` | extra patterns written to `.git/info/exclude`; `.dsh-checkpoint/` is always ignored |
| `max_draft_count` | `10` | drafts kept per workspace; the oldest draft is dropped when exceeded (confirmed checkpoints are never dropped) |
| `max_context_message_chars` | `1200` | per-message truncation limit for the context snapshot |
| `max_context_messages` | `40` | messages kept in a context snapshot |
| `max_context_bytes` | `524288` | hard cap for one serialized context; oldest messages are dropped first |
| `max_diff_chars` | `100000` | inline diff cap; longer diffs are stored under `.dsh-checkpoint/diffs/` |
| `confirmation_ttl_seconds` | `600` | lifetime of a confirmation token |

Trigger policy (also from the requirement document): a user command such as
`/checkpoint` always wins, an agent marking a subtask complete comes second, and
snapshotting every conversational turn is **off** by default.

## Storage layout

```
<workspace>/
├── .dsh-checkpoint/                 # plugin store (git-ignored)
│   ├── drafts/<id>.json             # draft records
│   ├── checkpoints/<id>.json        # confirmed records
│   ├── contexts/<id>.json           # serialized agent context sidecars
│   ├── diffs/<id>.patch             # full diffs too large to inline
│   ├── confirmations/<token>.json   # pending single-use tokens
│   ├── aliases/<draft-id>.json      # draft id → confirmed id
│   └── tmp-index                    # scratch index, deleted after each draft
└── .git/                            # file versions live in git, not here
    ├── info/exclude                 # managed ignore block
    └── refs/dsh-checkpoint/         # anchors that keep draft objects alive
```

File history is git's job. The plugin only stores what git cannot represent:
the context sidecars, metadata, and the draft anchors.

## Rollback semantics

1. A confirmation token is required (see below).
2. The working tree must be clean. If it is not, the rollback aborts and
   returns `status: "conflict"`, `reason: "worktree_dirty"`, the modified and
   untracked files, and instructions. **Uncommitted work is never discarded.**
3. Confirmed checkpoint → `git reset --hard <commit>` (the branch moves).
4. Draft checkpoint → `git read-tree --reset -u <draft commit>` (files are
   restored, the branch does **not** move, because a draft was never a commit).
5. The stored context sidecar is attached to the result as a digest: plan
   progress, the last user request, captured message count and tool usage. The
   agent is told to treat that digest as the authoritative post-rollback state
   and to re-read files from disk before assuming their contents.

The plugin does not rewrite DSH's live session log
(`session.v4.jsonl.zstd`). That file is the harness's source of truth and
rewriting it while DSH has it mapped in memory would corrupt the session.
Rehydration therefore happens through the tool result, which the agent sees in
its own context window — plus the sidecar on disk for any later session. This
limitation is listed in the roadmap.

## Safety rails

- **Two-phase destructive operations.** `confirm_checkpoint` and
  `rollback_checkpoint` never act on the first call. They mint a single-use
  token (`cfm-<hex>`, TTL 600s) bound to the exact payload via SHA-256, return
  a human-readable summary, and only execute when called again with that token.
  A different draft id or commit message invalidates the token
  (`confirmation_mismatch`); a reused or expired token is rejected.
- **No automatic conflict resolution.** Drifted working tree, moved `HEAD`,
  dirty rollback target — all return a conflict list for the operator to
  resolve manually.
- **Built-in ignore defaults.** `.dsh-checkpoint/`, VCS directories and the
  configured patterns are written to `.git/info/exclude` inside a managed,
  clearly delimited block; existing user content is preserved.
- **No deletion of confirmed checkpoints (MVP).** Only draft retention is
  automated, and only the oldest drafts beyond `max_draft_count`.
- **Local only.** No network calls, no telemetry, no remote operations. Push,
  pull, fetch, pull requests and multi-user collaboration are explicitly out of
  scope.
- **No blind commits.** The plugin only commits through `confirm_checkpoint`
  after operator approval; drafts never touch `HEAD`.

## Agent context capture

`create_draft_checkpoint` reads the current DSH session log:

```
$DSH_HOME/sessions/<bucket>/session-<id>/session.v4.jsonl.zstd
```

Selection order: explicit `--session-file` → `$DSH_SESSION_ID` directory match
(validated against the log header) → most recent log whose header `cwd` matches
the workspace. The log is zstd-compressed JSONL; records are parsed defensively
and unknown shapes are skipped with a warning.

Only meaningful context is kept:

- user messages with `source.kind === "user"` (runtime/time/model-selection
  injections and `<system-reminder>` blocks are dropped);
- assistant text and the tool names it called;
- the most recent `todo/write` plan;
- tool call/error counts.

Streaming payloads (`assistant/message` → `data.stream`), base64 blobs and data
URIs are never stored. Very long messages are truncated; when the payload
exceeds `max_context_bytes` the oldest messages are dropped first.

A missing session log is not an error: the checkpoint still captures files and
records a warning.

## Errors and conflicts

Tool failures return `isError: true` with a structured payload instead of
crashing the server:

```json
{ "ok": false, "error": { "code": "checkpoint_not_found", "message": "…", "details": {} } }
```

Confirmation challenges and conflicts are also `isError: true`, with
`status: "confirmation_required"` or `status: "conflict"` at the top level so an
agent cannot mistake them for success.

Error codes include `not_a_git_repo`, `nested_repository`,
`workspace_not_repository_root`, `git_unavailable`, `nothing_to_checkpoint`,
`checkpoint_not_found`, `checkpoint_incomplete`, `already_confirmed`,
`invalid_confirmation`, `confirmation_expired`, `confirmation_mismatch`,
`invalid_branch_name`, `branch_exists`, `branch_not_found`, `no_commits` and
`switch_failed`.

## Development

```bash
pnpm run typecheck   # tsc over src + tests, no emit
pnpm run build       # dist/ without tests
pnpm test            # builds, compiles tests, runs node:test
```

The suite covers the service against real temporary git repositories, the
config loader, the session-log reader (including zstd compressed fixtures), the
MCP transport itself (it spawns `dist/index.js` and talks to it as a client),
the loopback route (workspace resolution, timeline, loopback/method fences) and
the browser bundle (loaded in a `node:vm` sandbox with a React shim, so the slot
wiring and the display model are exercised without a DOM). 63 tests, no network
access, no writes outside the OS temp dir.

Layout:

```
src/index.ts      MCP stdio server (nine tools)
src/checkpoint.ts service: drafts, confirmation, rollback
src/host.ts       web host half: loopback git route
src/session.ts    DSH session-log discovery and digest
src/git.ts        system git wrapper
src/store.ts      .dsh-checkpoint storage and confirmation tokens
client/client.js  browser half: commit badge (no build step)
```

## Risks and maintenance surface

- **DSH session schema drift.** `session.v4` is a DSH implementation detail. If
  DSH bumps the version or reshapes records, context capture degrades (warnings,
  empty context) rather than corrupting checkpoints; the reader must then be
  updated. This is the plugin's deliberate maintenance surface.
- **Draft staleness.** A draft captures a tree, not a promise. If files change
  or `HEAD` moves before confirmation, the confirm is refused; create a new
  draft.
- **Large sessions.** Byte caps keep sidecars small; the trade-off is that very
  long conversations lose their oldest messages.
- **Git version differences.** `git switch` requires 2.23+; the plugin falls
  back to `git checkout`. Nothing else depends on a recent git.
- **Repository identity.** If the repository has no `user.name`/`user.email`
  configured, the plugin writes a repository-local placeholder identity so
  commits do not fail; set a real identity for real commits.
- **Client bundle contract.** `client/client.js` targets the DSH web slot API
  (`conversation.chat.assistant-actions`, `ctx.slots`/`ctx.locale`) and the
  `__ModuleLoader__` bundle shape. If DSH changes either, the badge disappears
  from the UI while the tools keep working; the host route and the display model
  stay independently testable, which is why they are split from the slot wiring.
- **Badge semantics.** The badge reports the current workspace HEAD, not the
  commit that existed when each reply was written; a dirty marker prevents it
  from implying the files match that commit.

## Roadmap

| Phase | Scope |
| --- | --- |
| 1 (MVP, this release) | `init_workspace`, draft/confirm/preview/list/rollback, default ignore rules, English README + MIT license |
| 2 | `create_branch`/`switch_branch` (already shipped in this release), tag search over large histories, snapshot size warnings, session-context rehydration that survives a DSH restart |
| 3 | Export/backup of the checkpoint store, a timeline UI, per-reply commit attribution from the timeline the route already returns, cross-workspace checkpoint index |

## License

MIT © icyleaf. See [LICENSE](./LICENSE).
