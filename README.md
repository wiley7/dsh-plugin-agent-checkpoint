# dsh-plugin-agent-checkpoint

**Session-aware task checkpoints for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).**
Go back to a milestone and both halves come back: the files *and* the agent
context that produced them.

|  |  |
| --- | --- |
| **What it is** | an MCP server (nine tools) plus a small browser badge, installed as one DSH plugin bundle |
| **What a checkpoint holds** | the exact working tree (as a git tree object) **and** a digest of the DSH session — plan, recent messages, tool usage |
| **File storage** | native `git` CLI, in your own repository; the plugin invents no new file format |
| **Context storage** | JSON sidecars under `.dsh-checkpoint/` in the workspace |
| **Destructive operations** | always two-phase: a human-confirmed, single-use token is required |
| **Automatic checkpoints** | optional, configured in DSH **Settings → Plugins**: off, on file change, every message, or every N messages |
| **Network** | none. Local only, no telemetry, no push/pull/fetch |
| **Requires** | Node.js ≥ 20, `git` ≥ 2.23 (recommended), a DSH build with `@deepseek-ai/dsh-mcp-client` |

Contents: [The problem](#the-problem) · [Feature tour](#feature-tour) ·
[How it works](#how-it-works) · [Quick start](#quick-start) ·
[Using it in a session](#using-it-in-a-session) ·
[Automatic checkpoints](#automatic-checkpoints) ·
[The commit badge](#the-commit-badge-in-the-web-ui) ·
[Tool reference](#tool-reference) · [Configuration](#configuration) · [Storage](#storage-layout) ·
[Safety model](#safety-model) · [Rollback](#rollback-semantics) ·
[Context capture](#agent-context-capture) · [Errors](#error-reference) ·
[Development](#development) · [Limitations](#limitations-and-roadmap)

---

## The problem

A coding session is not just a pile of files. It is files **plus** a direction:
the plan the agent is following, the decisions it just made, the command output
that justified them.

Snapshot tools that only copy files lose the second half. Roll back to “before
the refactor” and the files return, but the conversation has moved on — the agent
starts the milestone from a blank slate and re-discovers what it already knew.

`dsh-plugin-agent-checkpoint` treats the pair as one unit:

```
checkpoint = { git tree of the working directory } + { digest of the DSH session }
                    ↑                                        ↑
          restored by git                     handed back to the agent in the tool
          (files, exactly as they were)       result, and kept on disk as a sidecar
```

## Feature tour

### 1. Draft snapshots that never touch your branch

`create_draft_checkpoint` captures the whole working tree into a git tree object
and a **dangling commit**, anchored under `refs/dsh-checkpoint/drafts/<id>` so
garbage collection cannot prune it. `HEAD` never moves, nothing is staged in your
real index, and `git status` looks exactly as it did a moment before.

Each draft records the changed files with their status, a diff (inline, or a
`.patch` sidecar when huge), a byte-capped context digest, the workspace, the
branch, the base commit, and an id such as `draft-1792582824171-fb62938a`.

### 2. Preview before you commit to it

`preview_checkpoint` shows one checkpoint in full — title, remark, tags,
timestamps, file list, unified diff, context digest (plan progress, last user
request, tools used) and the bound commit hash (empty for drafts).
`list_checkpoints` gives the newest-first index, filterable by tags, by free-text
query, or restricted to confirmed snapshots.

### 3. Confirmation turns a draft into a real commit

`confirm_checkpoint` is the only code path in the plugin that commits:

```
git add --all
git commit --no-verify -m "<message>"
```

The commit hash is written back into the checkpoint record, the draft is retired,
and its `draft-…` id keeps resolving to the confirmed record. If the working tree
or `HEAD` drifted since the draft was taken, the confirm is **refused** with a
conflict report instead of quietly committing a mixture.

### 4. Rollback restores files *and* re-hands the context to the agent

`rollback_checkpoint` first refuses to run on a dirty working tree — uncommitted
work is never discarded. On a clean tree it restores a confirmed checkpoint with
`git reset --hard <commit>`, or a draft with `git read-tree --reset -u` (files
only; the branch does not move, because a draft was never a commit). The result
carries the stored context digest and the restored plan, and tells the agent to
treat it as authoritative and to re-read files from disk.

### 5. Branch off a checkpoint instead of losing work

`create_branch` starts a branch at a checkpoint commit (or at `HEAD`) so an
alternative can be explored without disturbing the current one; `switch_branch`
moves between them. Both are plain local git operations with validation —
nothing is pushed anywhere.

### 6. The commit badge — and enabling checkpoints from the UI

Every finalized reply in the DSH web UI gets a quiet pill showing the workspace
HEAD (`⎇ main 4e850e7`), a `*` when the tree is dirty, and a `⚑` when that commit
is a confirmed checkpoint. In a project that is not a git repository yet, the pill
becomes a dashed **⚙ Enable checkpoints** control that initialises the project —
behind a second click and a server-side `confirm=1` check.
[Details below.](#the-commit-badge-in-the-web-ui)

### 7. Automatic checkpoints, on your terms

The plugin can also save on its own — that is what the **Automatic checkpoints**
card under *Settings → Plugins* configures:

| Question | Choices |
| --- | --- |
| **When should it save?** | `Off` (only when you ask) · `Whenever files change` · `After every message` · `Every N messages` |
| **How should it save?** | `Keep as draft` (default) · `Commit right away` |

The default is *off* + *draft*, so turning the feature on can never write to your
git history by itself. `Commit right away` is the one setting that produces real
commits without a confirmation token — you opt into it explicitly, and the badge
under each reply shows the result.

No new HTTP route is involved: the browser card edits the `agent-checkpoint`
settings namespace through DSH's own settings service, and the host half reacts
to `turn/end` events. See [Automatic checkpoints](#automatic-checkpoints).

### Why not just `git stash` / `git commit` / tags?

| Plain git | This plugin |
| --- | --- |
| You must remember to commit, or stash and forget | Drafts are cheap, anchored, and never disturb `HEAD` |
| A stash has no plan, no conversation, no rationale | Each draft carries a session digest: plan, recent messages, tool usage |
| Restoring files leaves the agent amnesiac | Rollback returns the context digest into the agent's context window |
| `git reset --hard` discards uncommitted work | Rollback refuses on a dirty tree and reports the files instead |
| Committing is one keystroke away for an agent | Committing needs a payload-bound, single-use token the operator approved |
| Nothing links git history to “which milestone” | Confirmed checkpoints annotate the history the badge reads |

## How it works

One npm package, two halves, mounted by a profile bundle patch (`cordis.patch.yml`):

```
                        ┌──────────────────────────────┐
  Agent ──────────────▶ │  MCP stdio server            │
  (nine tools)          │  dist/index.js               │
                        └───────┬──────────┬───────────┘
                                │          │
                     ┌──────────┘          └───────────┐
                     ▼                                 ▼
            system git CLI                    .dsh-checkpoint/
            (trees, commits,                  (records, context
             refs, branches)                   sidecars, tokens)
                     ▲                                 ▲
                     │                                 │
  Browser badge ─────┴──── host plugin  ◀──────────────┘
  (client.js)              dist/host.js
        │                        │
        └── GET /api/agent-checkpoint/git ──────┐
            POST /api/agent-checkpoint/init ────┘

  DSH session log (read-only) ──▶ context capture ──▶ .dsh-checkpoint/contexts/
```

- **The MCP server owns writes.** Nine tools, spawned over stdio by
  `@deepseek-ai/dsh-mcp-client`, exposed to the agent as
  `mcp__agent-checkpoint__<tool>`.
- **The host plugin owns two loopback routes.** The browser cannot run git, so
  the badge asks the host half; the git route never commits, stages or resets,
  and both routes are loopback-only.
- **The browser half is a slot registration**, not a separate app: a
  `__ModuleLoader__` bundle that renders into
  `conversation.chat.assistant-actions`.

## Quick start

```bash
git clone git@github.com:wiley7/dsh-plugin-agent-checkpoint.git
cd dsh-plugin-agent-checkpoint
pnpm install
pnpm run build                 # emits dist/ (host half + MCP server)
node dist/index.js --help      # sanity check the server half
```

`git` must already be on `PATH`; the plugin never installs or bundles it.

### Register with DSH

| Half | Composited entry | What it contributes |
| --- | --- | --- |
| MCP server | `agent-checkpoint-mcp` → `@deepseek-ai/dsh-mcp-client` | the nine tools, spawned over stdio |
| Host plugin | `agent-checkpoint` → `dsh-plugin-agent-checkpoint` | the loopback routes the badge reads |

**Option A — install as a bundle (recommended).** A profile's user layer can only
patch entries that already exist, so a bundle is the supported path:

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-plugin-agent-checkpoint
# or, once published:  add dsh-plugin-agent-checkpoint
```

The package declares `dsh.bundle.patch`, so DSH records it in
`dsh.profile.bundles` and applies `cordis.patch.yml` on the next boot. Restart
DSH: the tools appear as `mcp__agent-checkpoint__*` and the badge appears under
every finalized assistant reply.

Workspace resolution, highest priority first: an explicit tool argument →
`?workspace=` on the route → the **cwd of the session being viewed** (read from
its log header) → the entry config → `$DSH_AGENT_CHECKPOINT_WORKSPACE` →
`$DSH_WORKSPACE` → the directory DSH was launched from. To pin both halves:

```bash
export DSH_AGENT_CHECKPOINT_WORKSPACE=/absolute/path/to/your/project
```

Or override the entries in the profile's own `cordis.patch.yml` — note that an
override **replaces** the whole `config` object, so repeat every key:

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
to the installed copy of the server.

**Option B — insert the entries by hand** (without installing the package into
the profile):

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

A bare `- id: …` entry at the top level does **not** work: entries without
`insert:` only override entries that already exist. Drop the host entry if you
want the tools without the badge — the MCP half works on its own, including in
`headless` profiles where no web server exists.

### Verify the registration

```bash
dsh --profile web --dump-config | grep -A 12 agent-checkpoint   # both entries present
curl -s 'http://127.0.0.1:<port>/api/agent-checkpoint/git' | head -c 400
```

If the MCP server fails to start, DSH reports the spawn error at boot; run it by
hand (`node dist/index.js --workspace <project>`) to read its own diagnostics.

## Using it in a session

A milestone looks like this. The operator (or the agent, at a milestone boundary)
takes a draft; the operator reviews it; confirming produces a real commit.

```
init_workspace                                  # once per project
  └─ create_draft_checkpoint "login flow done"  # cheap, does not commit
       └─ preview_checkpoint <draft-id>         # operator reviews diff + context
            └─ confirm_checkpoint <draft-id> "feat: login flow"   # needs a token
                 └─ … next milestone …
                      └─ rollback_checkpoint <ckpt-id>            # needs a token
```

Two-phase confirmation, seen from the agent's side:

```jsonc
// 1st call — never destructive; it mints a token and returns a summary
{"draft_id": "draft-1792582824171-fb62938a", "commit_message": "feat: login flow"}
// → isError: true, status: "confirmation_required",
//   confirmation_id: "cfm-4f0c…", summary: "…", details: {…}, expires_at: "…"

// 2nd call — the same payload plus the token the operator approved
{"draft_id": "draft-1792582824171-fb62938a", "commit_message": "feat: login flow",
 "confirmation_id": "cfm-4f0c…"}
// → isError: false, status: "confirmed", commit_hash: "4e850e71be0a…",
//   checkpoint_id: "ckpt-1792582824171-9b2c9d71"
```

The token is bound to the exact payload by SHA-256: changing the draft id or the
message invalidates it (`confirmation_mismatch`), it expires after
`confirmation_ttl_seconds` (default 600 s), and it is consumed on use.

Every tool also accepts an optional absolute `workspace` argument, so one stdio
server can snapshot, roll back and branch several projects without a restart.

## Automatic checkpoints

By default the plugin only saves when you ask the assistant to. If you would
rather have it save by itself, open **Settings → Plugins → Automatic checkpoints**
(the card appears only when the host half is loaded, because the card and the
namespace are the two halves of the same feature).

### The two questions the card asks

**When should it save?**

| Choice | Behaviour |
| --- | --- |
| `Off` (default) | nothing is created automatically; ask for a checkpoint when you want one |
| `Whenever files change` | a snapshot after any turn that modified files; quiet turns are skipped |
| `After every message` | a snapshot after every turn, including the conversation when no file changed |
| `Every N messages` | a snapshot every N turns (`N` = 1–50, default 5) |

**How should it save?**

| Choice | Behaviour |
| --- | --- |
| `Keep as draft` (default) | the snapshot lands in `.dsh-checkpoint/` and never enters git history until you confirm it |
| `Commit right away` | each snapshot becomes a real `git commit`, authored as `checkpoint: automatic save after turn N` |

### What the automation will not do

- **It never initialises a repository.** A session whose project is not a git
  repository root is skipped — enabling checkpoints stays the explicit
  **⚙ Enable checkpoints** click described below.
- **It never uses a fallback directory.** The workspace comes from the session log
  header (`source: "session"`); a standalone `dsh` launch directory is never
  checkpointed by accident.
- **It never forces a commit past a conflict.** With `Commit right away`, the same
  guards as `confirm_checkpoint` run: if HEAD moved or the tree drifted since the
  draft was captured, the draft is kept and the commit is skipped (logged to
  stderr).
- **It never saves the same turn twice**, and evaluations for one session are
  serialised, so a slow snapshot cannot interleave with the next turn.

### How the setting is stored

The card edits a DSH settings section named `agent-checkpoint`:

```json
{ "trigger": "off", "apply": "draft", "interval_turns": 5 }
```

DSH persists it (`applies: "live"`, so a change takes effect on the next turn);
the host half registers the namespace with a [schemastery](https://github.com/shigma/schemastery)
schema, and falls back to an equivalent hand-written schema when the host does not
expose `@deepseek-ai/schemastery` — the plugin never fails to start because of it.
Builds without a settings service simply show no card and never save
automatically.

This is separate from `checkpoint.config.json`: that file holds per-workspace
limits and ignore rules (see [Configuration](#configuration)); the trigger policy
lives in DSH settings so it is editable without touching the project.

## The commit badge in the web UI

```
⎇ main 4e850e7 *    ⚑
```

- `4e850e7` — short hash of the workspace HEAD; **click copies the full hash**;
  the tooltip carries branch, subject, commit time, checkpoint id and workspace.
- `*` — the working tree has uncommitted changes, so the badge never implies the
  files match that commit.
- `⚑` — that commit is a **confirmed checkpoint**; hover for its title.

### Enabling checkpoints from the UI

In a project that is not a git repository yet, the pill becomes a dashed
**⚙ Enable checkpoints** control instead of disappearing:

1. **First click arms it** — nothing is written; it becomes an amber
   `Confirm setup` button plus a `✕` cancel, so a stray click initialises nothing.
2. **Second click** posts `POST /api/agent-checkpoint/init?session=<id>&confirm=1`.
3. The host half runs the same path as `init_workspace`: `git init
   --initial-branch=main` when needed, `.gitignore` defaults appended, the managed
   block written to `.git/info/exclude`, the `.dsh-checkpoint/` store created. The
   control then re-fetches and becomes the normal commit pill — no reload.

The control is only offered when the workspace came from the session being viewed
(`source: "session"`); for the `cwd` fallback DSH merely launched from, nothing is
shown — the plugin never offers to `git init` a directory the user did not point
at. A folder that lives inside another repository answers
`409 workspace_not_repository_root` and is left untouched.

### Route reference

| Aspect | `GET /api/agent-checkpoint/git` | `POST /api/agent-checkpoint/init` |
| --- | --- | --- |
| Purpose | read the badge snapshot | enable checkpoints for a project |
| Access | loopback only (`127.0.0.0/8`, `::1`, `::ffff:` forms); else `403` | same |
| Methods | `GET`, `HEAD`; else `405` | `POST`; else `405` |
| Guard | none | `confirm=1` required, else `400 confirmation_required` and **no write** |
| Response | `{ ok, workspace, source, isRepo, branch, head, isDirty, commits[], capturedAt, error, warnings }` | `{ ok, workspace, created, gitVersion, branch, head, gitignoreUpdated, excludeUpdated, storePath, configPath, warnings, nextSteps }` |
| Caching | `cache-control: no-store` | same |
| Writes | none — never commits, stages or resets | working tree and `.git` (init, ignore rules, store) |
| Errors | `not_a_git_repo`, `invalid_workspace` | `confirmation_required`, `workspace_not_repository_root` (409) |

`GET` also accepts `?workspace=<path>` and `?limit=<n>`; the badge polls every
20 s (paused while the tab is hidden), shares one request per session, and
memoizes snapshots for 8 s. The route is read-only on purpose: a UI that could
move `HEAD` would make the “no destructive operation without confirmation”
guarantee meaningless.

The badge reports the *current* HEAD, not the commit that existed when each reply
was written. Per-reply attribution needs the per-turn timeline the route already
returns; it is a roadmap item, not a promise.

Badge configuration (entry config of the host half): `workspace` (fallback when a
request carries no `?session=`) and `maxCommits` (default `120`; requests clamp at
`500`). The browser half itself has no configuration — it registers into the
`conversation.chat.assistant-actions` list slot with id `agent-checkpoint-commit`
and order `60`, so it coexists with the built-in feedback buttons rather than
competing for the single `turnTail` chain slot.

## Tool reference

All nine tools are exposed as `mcp__agent-checkpoint__<name>`. Every one accepts
an optional `workspace` (absolute path of the project) in addition to the
arguments below. **Destructive** tools require the two-phase confirmation
described above.

### `init_workspace`
Prepares a project: checks git, initialises a repository when needed, appends the
plugin's `.gitignore` defaults, writes the managed `.git/info/exclude` block,
creates the store, and returns repository state plus next steps.
Arguments: `workspace_path?`. Idempotent.

### `create_draft_checkpoint`
Captures files **and** agent context without committing. Returns `draft_id`,
`files`, `diff_stat`, `diff`, `context_summary`, plus warnings. Refuses with
`nothing_to_checkpoint` when nothing changed and no context was captured.
Arguments: `title`, `tags?`, `remark?`.

### `preview_checkpoint`
Full view of one checkpoint: metadata, file list, diff, context digest, and the
commit hash it is bound to (`null` for drafts). Arguments: `checkpoint_id` (a
unique fragment is accepted), `include_diff?` (default `true`), `max_diff_chars?`
(default 12000, max 200000).

### `confirm_checkpoint` **(destructive)**
The first call returns a confirmation token and a summary; the second call
commits and returns `commit_hash` plus the confirmed `checkpoint_id`. Refuses with
a conflict report when `HEAD` moved or the working tree changed since the draft.
Arguments: `draft_id`, `commit_message`, `confirmation_id?`.

### `rollback_checkpoint` **(destructive)**
The first call returns a token and a summary; the second call restores files and
returns the context digest, the restored plan and rehydration instructions. Aborts
with `status: "conflict"` when the working tree is dirty.
Arguments: `checkpoint_id`, `confirmation_id?`.

### `list_checkpoints`
Newest-first index. Arguments: `tags_filter?` (all listed tags must match),
`limit?` (default 20, max 200), `include_drafts?` (default `true`), `query?`
(substring over title, remark, tags and context digest).

### `create_branch` / `switch_branch`
Local-only branch management. `create_branch` takes `branch_name` (validated with
`git check-ref-format`) and an optional `checkpoint_id` to start from;
`switch_branch` takes `branch_name`. `git switch` is used when available and
`git checkout` otherwise.

### `get_status`
Read-only report: repository status, branch, `HEAD`, dirty and untracked files,
draft/confirmed counts, effective policy, newest checkpoint, pending
confirmations, and hints. Takes no arguments besides `workspace`.

### Checkpoint ids

Stable, human-readable strings such as `draft-1792582824171-fb62938a` and
`ckpt-1792582824171-9b2c9d71`. Any unique fragment is accepted. After a draft is
confirmed, its `draft-…` id keeps resolving to the confirmed record through an
alias.

### CLI options

`node dist/index.js` is the MCP server half (normally spawned by DSH; useful
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

## Configuration

Optional `checkpoint.config.json` in the workspace root. Missing fields fall back
to the defaults; invalid values produce warnings but never abort a tool call.

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
| `max_draft_count` | `10` | drafts kept per workspace; the oldest is dropped beyond this (confirmed checkpoints are never dropped) |
| `max_context_message_chars` | `1200` | per-message truncation limit in the context snapshot |
| `max_context_messages` | `40` | messages kept per context snapshot |
| `max_context_bytes` | `524288` | hard cap per serialized context; oldest messages are dropped first |
| `max_diff_chars` | `100000` | inline diff cap; longer diffs go to `.dsh-checkpoint/diffs/` |
| `confirmation_ttl_seconds` | `600` | lifetime of a confirmation token |

`auto_draft_on_milestone` is a *hint* read by `get_status`; it does not create
anything. The behaviour that actually saves automatically lives in
[Automatic checkpoints](#automatic-checkpoints) (DSH settings), not in this file.

## Storage layout

```
<workspace>/
├── .dsh-checkpoint/                 # plugin store (git-ignored)
│   ├── drafts/<id>.json             # draft records
│   ├── checkpoints/<id>.json        # confirmed records
│   ├── contexts/<id>.json           # serialized agent context sidecars
│   ├── diffs/<id>.patch             # diffs too large to inline
│   ├── confirmations/<token>.json   # pending single-use tokens
│   ├── aliases/<draft-id>.json      # draft id → confirmed id
│   └── tmp-index                    # scratch index, deleted after each draft
└── .git/                            # file versions live in git, not here
    ├── info/exclude                 # managed ignore block
    └── refs/dsh-checkpoint/         # anchors keeping draft objects alive
```

File history is git's job. The plugin stores only what git cannot represent: the
context sidecars, the metadata, and the anchors that keep draft objects from being
pruned.

A record carries: `id`, `status` (`draft`/`confirmed`), `title`, `tags`, `remark`,
timestamps, workspace, branch, `base_commit`, `tree_hash`, `draft_commit`,
`commit_hash`, `parent_commit`, `files`, `diff_stat`, `diff` (or `diff_path`),
`context_path`, `context_summary`, `session_id` and `anchor_ref`.

## Safety model

- **Two-phase destructive operations.** `confirm_checkpoint` and
  `rollback_checkpoint` never act on the first call. They mint a single-use token
  (`cfm-<hex>`, TTL 600 s) bound to the exact payload via SHA-256, return a
  human-readable summary, and execute only when called again with that token.
- **No automatic conflict resolution.** Drifted working tree, moved `HEAD`, dirty
  rollback target — each returns a conflict list (`status: "conflict"`) with the
  affected files for the operator to resolve manually.
- **Uncommitted work is never discarded.** Rollback refuses on a dirty tree.
- **Drafts never touch `HEAD`.** Capture uses a scratch index
  (`GIT_INDEX_FILE=.dsh-checkpoint/tmp-index`) plus a dangling commit anchored by
  a ref, so the branch and the real index are untouched.
- **Built-in ignore defaults** live in a managed, clearly delimited block inside
  `.git/info/exclude`; existing user content is preserved.
- **No deletion of confirmed checkpoints** in this release; only the oldest drafts
  beyond `max_draft_count` are trimmed.
- **Loopback-only UI routes**, POST-only initialisation behind `confirm=1`.
- **Local only.** No network calls, no telemetry, no remote operations. Push,
  pull, fetch, pull requests and multi-user collaboration are out of scope.

## Rollback semantics

1. A confirmation token is required (see above).
2. The working tree must be clean. Otherwise the rollback aborts with
   `status: "conflict"`, `reason: "worktree_dirty"`, the modified and untracked
   files, and instructions.
3. Confirmed checkpoint → `git reset --hard <commit>` (the branch moves).
4. Draft checkpoint → `git read-tree --reset -u <draft commit>` (files return; the
   branch does **not** move, because a draft was never a commit).
5. The stored context sidecar is attached as a digest: plan progress, the last
   user request, captured message count and tool usage. The agent is told to treat
   that digest as the authoritative post-rollback state and to re-read files from
   disk before assuming their contents.

The plugin deliberately does **not** rewrite DSH's live session log
(`session.v4.jsonl.zstd`). That file is the harness's source of truth; rewriting it
while DSH has it mapped in memory would corrupt the session. Rehydration happens
through the tool result (which the agent sees in its own context window) plus the
sidecar on disk for later sessions.

## Agent context capture

`create_draft_checkpoint` reads the current DSH session log:

```
$DSH_HOME/sessions/<bucket>/session-<id>/session.v4.jsonl.zstd
```

Selection order: explicit `--session-file` → `$DSH_SESSION_ID` directory match
(validated against the log header) → the most recent log whose header `cwd`
matches the workspace. The log is zstd-compressed JSONL; records are parsed
defensively and unknown shapes are skipped with a warning. Decompression prefers
`node:zlib`'s zstd support and falls back to the `zstd` CLI.

Only meaningful context is kept:

- user messages with `source.kind === "user"` (runtime/time/model-selection
  injections and `<system-reminder>` blocks are dropped);
- assistant text and the names of the tools it called;
- the most recent `todo/write` plan;
- tool call/error counts.

Streaming payloads (`assistant/message` → `data.stream`), base64 blobs and data
URIs are never stored. Very long messages are truncated; when a payload exceeds
`max_context_bytes`, the oldest messages are dropped first. A missing session log
is not an error — the checkpoint still captures files and records a warning.

## Error reference

Tool failures return `isError: true` with a structured payload instead of crashing
the server:

```json
{ "ok": false, "error": { "code": "checkpoint_not_found", "message": "…", "details": {} } }
```

Confirmation challenges and conflicts are also `isError: true`, with
`status: "confirmation_required"` or `status: "conflict"` at the top level, so an
agent cannot mistake them for success.

| Code | Meaning |
| --- | --- |
| `git_unavailable` | no `git` binary on `PATH` |
| `git_init_failed` | `git init` (or the ignore-rule scaffolding) failed |
| `not_a_git_repo` / `nested_repository` | workspace is not a repository / lives inside another one |
| `workspace_not_repository_root` | the target is a subdirectory of a repository |
| `nothing_to_checkpoint` | no file changes and no context to capture |
| `checkpoint_not_found` / `checkpoint_incomplete` | unknown id / record missing its tree |
| `already_confirmed` | the draft was already turned into a commit |
| `invalid_confirmation` / `confirmation_expired` / `confirmation_mismatch` | token unknown, expired, or bound to a different payload |
| `invalid_branch_name` / `branch_exists` / `branch_not_found` / `no_commits` / `switch_failed` | branch management failures |
| `internal_error` | an unexpected failure; the message carries the detail |

## Development

```bash
pnpm run typecheck   # tsc over src + tests, no emit
pnpm run build       # dist/ without tests
pnpm test            # builds, compiles tests, runs node:test
```

The suite covers the service against real temporary git repositories, the config
loader, the session-log reader (including zstd fixtures), the MCP transport itself
(it spawns `dist/index.js` and talks to it as a client), both loopback routes
(workspace resolution, timeline, method and loopback fences, the init guard) and
the browser bundle (loaded in a `node:vm` sandbox with a React shim, so slot wiring,
the display model and the init control are exercised without a DOM).
**112 tests, no network access, no writes outside the OS temp dir.**

```
src/index.ts      MCP stdio server (nine tools)
src/checkpoint.ts service: drafts, confirmation, rollback
src/host.ts       web host half: loopback git + init routes
src/session.ts    DSH session-log discovery and digest
src/git.ts        system git wrapper
src/store.ts      .dsh-checkpoint storage and confirmation tokens
client/client.js  browser half: commit badge (no build step)
```

## Limitations and roadmap

| Area | Today | Next |
| --- | --- | --- |
| Destructive ops | two-phase token | same, plus approving from the badge |
| Context rehydration | tool result digest + sidecar | survive a DSH restart by re-reading sidecars into a fresh session |
| Badge | current `HEAD` per reply | per-reply attribution from the per-turn timeline the route already returns |
| Auto triggers | off / file change / every turn / every N turns (settings card) | per-language rules, per-workspace overrides, "only when tests pass" |
| Settings surface | trigger + save mode | ignore rules and draft limits editable from the same card |
| Branching | local create/switch | store export/backup, timeline UI, cross-workspace index |
| Out of scope | push/pull/fetch, remotes, collaboration, automatic conflict resolution, binary large-object handling, background scheduling, checkpoint deletion | — |

Known maintenance surfaces:

- **DSH session schema drift.** `session.v4` is a DSH implementation detail. If DSH
  bumps the version or reshapes records, context capture degrades to warnings
  (never to corrupted checkpoints) and the reader must be updated. This is the
  plugin's deliberate maintenance surface.
- **Draft staleness.** A draft captures a tree, not a promise. If files change or
  `HEAD` moves before confirmation, the confirm is refused — take a new draft.
- **Repository identity.** Without `user.name`/`user.email`, the plugin writes a
  repository-local placeholder identity so commits do not fail; set a real identity
  for real commits.
- **Client bundle contract.** `client/client.js` targets the DSH web slot API
  (`conversation.chat.assistant-actions`, `ctx.slots`/`ctx.locale`) and the
  `__ModuleLoader__` bundle shape. If DSH changes either, the badge disappears while
  the tools keep working — which is why the display model is testable independently
  of the slot wiring.
- **Settings schema drift.** The card and the host half agree on one namespace and
  three fields (`trigger`, `apply`, `interval_turns`). The client normalizes unknown
  values field by field, so a newer host can add a trigger id without blanking the
  card, but new fields need both halves updated.
- **git version differences.** `git switch` needs 2.23+; the plugin falls back to
  `git checkout`. Nothing else requires a recent git.

## License

MIT © icyleaf. See [LICENSE](./LICENSE).
