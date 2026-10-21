#!/usr/bin/env node
/**
 * dsh-agent-checkpoint — MCP stdio server.
 *
 * Binds working-tree git snapshots to the DSH agent context that produced them.
 * Exposes exactly the nine tools from the requirement document, plus the safety
 * rails: `confirm_checkpoint` and `rollback_checkpoint` never act without a
 * single-use operator confirmation token.
 *
 * stdout is the MCP channel; all diagnostics go to stderr.
 *
 * @module dsh-plugin-agent-checkpoint
 */

import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { CheckpointError, CheckpointService } from './checkpoint.js';
import type { CheckpointRecord, PendingConfirmation } from './types.js';

/** Server version, kept in sync with package.json. */
const VERSION = '0.1.0';

/** MCP server name; the DSH client prefixes tools with it. */
const SERVER_NAME = 'agent-checkpoint';

interface CliOptions {
  workspace: string;
  sessionFile: string | null;
}

/** Minimal argv parsing: `--workspace <path>`, `--session-file <path>`, `--help`. */
function parseArgs(argv: string[]): CliOptions | 'help' {
  const options: CliOptions = {
    workspace: process.env.DSH_WORKSPACE ?? process.cwd(),
    sessionFile: process.env.DSH_SESSION_FILE ?? null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--version' || arg === '-v') {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    }
    if (arg === '--workspace' || arg === '-C' || arg === '--cwd') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      options.workspace = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--workspace=')) {
      options.workspace = arg.slice('--workspace='.length);
      continue;
    }
    if (arg === '--session-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--session-file requires a path');
      options.sessionFile = value;
      index += 1;
      continue;
    }
  }
  return options;
}

const HELP = `dsh-agent-checkpoint ${VERSION}

Usage: dsh-agent-checkpoint [options]

Options:
  -C, --workspace <path>     workspace (git repository root) to manage
                             (default: $DSH_WORKSPACE or the current directory)
      --session-file <path>  read agent context from an explicit DSH session log
  -v, --version              print the version and exit
  -h, --help                 print this help and exit

Runs as an MCP stdio server. Register it in a DSH profile as:

  - id: plugin-agent-checkpoint
    name: "@deepseek-ai/dsh-mcp-client"
    config:
      transport: stdio
      serverName: agent-checkpoint
      command: node
      args: ["<plugin>/dist/index.js", "--workspace", "<workspace>"]
`;

type ToolText = { type: 'text'; text: string };

/** Result envelope shared by every tool. */
export interface ToolEnvelope {
  ok: boolean;
  /** Machine-readable payload. */
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
  warnings?: string[];
}

function textResult(envelope: ToolEnvelope, markdown?: string): { content: ToolText[]; isError?: boolean } {
  const body = markdown ? `${markdown}\n\n<details>\n<summary>structured result</summary>\n\n\`\`\`json\n${JSON.stringify(envelope.data ?? envelope.error, null, 2)}\n\`\`\`\n\n</details>` : `\`\`\`json\n${JSON.stringify(envelope.data, null, 2)}\n\`\`\``;
  return envelope.ok
    ? { content: [ { type: 'text', text: body } ] }
    : { content: [ { type: 'text', text: body } ], isError: true };
}

function errorResult(error: unknown): { content: ToolText[]; isError: true } {
  if (error instanceof CheckpointError) {
    return {
      content: [
        {
          type: 'text',
          text: `\`\`\`json\n${JSON.stringify({ ok: false, error: { code: error.code, message: error.message, details: error.details } }, null, 2)}\n\`\`\``,
        },
      ],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: 'text',
        text: `\`\`\`json\n${JSON.stringify({ ok: false, error: { code: 'internal_error', message } }, null, 2)}\n\`\`\``,
      },
    ],
    isError: true,
  };
}

function bulletFiles(record: Pick<CheckpointRecord, 'files'>): string {
  if (record.files.length === 0) return '- (no file changes)';
  return record.files
    .slice(0, 40)
    .map((file) => `- \`${file.status}\` ${file.path}`)
    .join('\n');
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Build and configure the MCP server. */
export function buildServer(options: CliOptions): McpServer {
  const service = new CheckpointService(path.resolve(options.workspace));
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: [
        'dsh-agent-checkpoint pairs working-tree git snapshots with the DSH agent context that produced them.',
        'Typical flow: init_workspace → create_draft_checkpoint at a milestone → preview_checkpoint → confirm_checkpoint (only after the operator explicitly approves; the first call returns a confirmation id) → later rollback_checkpoint to a checkpoint.',
        'confirm_checkpoint and rollback_checkpoint are destructive: they return status "confirmation_required" with a confirmationId and do nothing until called again with that id. Never fabricate a confirmation id and never assume approval.',
        'Rollbacks abort with a conflict list instead of overwriting uncommitted work.',
      ].join('\n'),
    },
  );

  // 1. init_workspace ------------------------------------------------------
  server.registerTool(
    'init_workspace',
    {
      title: 'Initialise workspace',
      description:
        'Create a git repository (when missing) for the workspace and install the plugin .gitignore defaults plus the ignore rules used by drafts. Idempotent and safe to call at the start of every session.',
      inputSchema: {
        workspace_path: z
          .string()
          .optional()
          .describe('Absolute path of the workspace to manage. Defaults to the workspace the server was started with.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspace_path }) => {
      try {
        const result = await service.initWorkspace(workspace_path ?? service.workspace);
        const markdown = [
          `## Workspace ready: \`${result.workspace}\``,
          '',
          `- git: ${result.gitVersion ?? 'unknown'}${result.created ? ' (repository created)' : ' (existing repository)'}`,
          `- branch: \`${result.branch ?? '(detached)'}\`, HEAD: \`${result.head?.slice(0, 12) ?? 'no commits yet'}\``,
          `- snapshot store: \`${result.storePath}\``,
          `- policy config: \`${result.configPath}\`${result.configFound ? '' : ' (defaults applied)'}`,
          result.warnings.length > 0 ? `\n**Warnings**\n\n${result.warnings.map((warning) => `- ${warning}`).join('\n')}` : '',
          '',
          `**Next steps**\n\n${result.nextSteps.map((step) => `- ${step}`).join('\n')}`,
        ]
          .filter((line) => line !== '')
          .join('\n');
        return textResult({ ok: true, data: result, warnings: result.warnings }, markdown);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 2. create_draft_checkpoint --------------------------------------------
  server.registerTool(
    'create_draft_checkpoint',
    {
      title: 'Create draft checkpoint',
      description:
        'Capture a milestone draft: the current working-tree state as a git tree object plus a serialized snapshot of the DSH agent context (task plan, recent messages, tool usage). Creates no commit and does not move HEAD.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('Short human-readable title for the checkpoint.'),
        tags: z.array(z.string().min(1).max(40)).max(20).optional().describe('Free-form tags used by list_checkpoints filtering.'),
        remark: z.string().max(2000).optional().describe('Optional note explaining why this milestone matters.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, tags, remark }) => {
      try {
        const result = await service.createDraft({
          title,
          tags: tags ?? [],
          remark: remark ?? '',
          sessionFile: options.sessionFile,
        });
        const markdown = [
          `## Draft checkpoint \`${result.draftId}\``,
          '',
          `**${result.title}**${result.tags.length > 0 ? ` · tags: ${result.tags.map((tag) => `\`${tag}\``).join(', ')}` : ''}`,
          '',
          `- branch \`${result.branch ?? '(detached)'}\`, base \`${result.baseCommit?.slice(0, 12) ?? 'no commits'}\` → tree \`${result.treeHash.slice(0, 12)}\``,
          `- ${result.filesChanged} file(s) changed`,
          '',
          '**Files**',
          '',
          bulletFiles(result),
          '',
          result.diffStat ? `\`\`\`\n${result.diffStat}\n\`\`\`` : '',
          '',
          '**Agent context captured**',
          '',
          `\`\`\`\n${result.contextSummary || '(no context captured)'}\n\`\`\``,
          '',
          result.warnings.length > 0 ? `**Warnings**\n\n${result.warnings.map((warning) => `- ${warning}`).join('\n')}\n` : '',
          `**Next**\n\n${result.next}`,
        ]
          .filter((line) => line !== '')
          .join('\n');
        return textResult({ ok: true, data: result, warnings: result.warnings }, markdown);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 3. preview_checkpoint --------------------------------------------------
  server.registerTool(
    'preview_checkpoint',
    {
      title: 'Preview checkpoint',
      description:
        'Show one checkpoint in full: title, remark, tags, timestamps, file diffs, the serialized agent-context digest and the bound commit hash (empty for drafts). Read-only.',
      inputSchema: {
        checkpoint_id: z.string().min(2).describe('Checkpoint id, or a unique fragment of it.'),
        include_diff: z.boolean().optional().describe('Include the unified diff in the response (default true).'),
        max_diff_chars: z.number().int().min(1000).max(200_000).optional().describe('Cap the diff body length (default 12000).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ checkpoint_id, include_diff, max_diff_chars }) => {
      try {
        const result = await service.previewCheckpoint({
          checkpointId: checkpoint_id,
          includeDiff: include_diff,
          maxDiffChars: max_diff_chars,
        });
        const record = result.checkpoint;
        const markdown = [
          `## ${record.status === 'confirmed' ? 'Confirmed' : 'Draft'} checkpoint \`${record.id}\``,
          '',
          `**${record.title}**`,
          '',
          `- status: ${record.status}`,
          `- created: ${record.createdAt}`,
          `- tags: ${record.tags.length > 0 ? record.tags.map((tag) => `\`${tag}\``).join(', ') : '(none)'}`,
          `- branch: \`${record.branch ?? '(detached)'}\``,
          `- commit: \`${record.commitHash ?? '(draft — not committed)'}\``,
          `- files changed: ${record.files.length}`,
          record.remark ? `- remark: ${record.remark}` : '',
          '',
          '**Files**',
          '',
          bulletFiles(record),
          '',
          record.diffStat ? `**Diff stat**\n\n\`\`\`\n${record.diffStat}\n\`\`\`` : '',
          result.diff ? `**Diff${result.diffTruncated ? ' (truncated)' : ''}**\n\n\`\`\`diff\n${result.diff}\n\`\`\`` : '',
          '**Agent context digest**',
          '',
          `\`\`\`\n${result.contextDigest}\n\`\`\``,
          result.context && result.context.messages.length > 0
            ? `\nCaptured ${result.context.messages.length} message(s) from session \`${result.context.sessionId ?? 'unknown'}\` (${result.context.bytes} bytes${result.context.truncated ? ', truncated' : ''}).`
            : '',
        ]
          .filter((line) => line !== '')
          .join('\n');
        return textResult(
          {
            ok: true,
            data: {
              checkpoint: record,
              diff: result.diff,
              diffTruncated: result.diffTruncated,
              contextDigest: result.contextDigest,
              context: result.context,
            },
          },
          markdown,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 4. confirm_checkpoint --------------------------------------------------
  server.registerTool(
    'confirm_checkpoint',
    {
      title: 'Confirm draft checkpoint (requires operator approval)',
      description:
        'HIGH RISK. Commit a draft checkpoint as a real git commit. Without confirmation_id this call only returns a single-use confirmation token and does nothing else: show the operator the summary, and repeat the call with the token only after they explicitly approve. Refuses when HEAD moved or the working tree drifted since the draft.',
      inputSchema: {
        draft_id: z.string().min(2).describe('Draft checkpoint id (or a unique fragment).'),
        commit_message: z.string().min(1).max(2000).describe('Commit message for the resulting commit.'),
        confirmation_id: z
          .string()
          .optional()
          .describe('Single-use token from a previous call to this tool, after explicit operator approval.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ draft_id, commit_message, confirmation_id }) => {
      try {
        const result = await service.confirmCheckpoint({
          draftId: draft_id,
          commitMessage: commit_message,
          confirmationId: confirmation_id,
        });
        if (result.status === 'confirmation_required') {
          return pendingConfirmationResult(result);
        }
        if (result.status === 'conflict') {
          return conflictResult(result);
        }
        const markdown = [
          `## Confirmed \`${result.checkpointId}\``,
          '',
          `- commit: \`${result.commitHash}\``,
          `- message: ${result.commitMessage}`,
          `- branch: \`${result.branch ?? '(detached)'}\``,
          `- files changed: ${result.filesChanged}`,
          `- draft \`${result.draftId}\` was promoted; its context snapshot is at \`${result.contextPath}\``,
        ].join('\n');
        return textResult({ ok: true, data: result }, markdown);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 5. list_checkpoints ----------------------------------------------------
  server.registerTool(
    'list_checkpoints',
    {
      title: 'List checkpoints',
      description:
        'List checkpoints newest-first, optionally filtered by tags and free-text query. Read-only.',
      inputSchema: {
        tags_filter: z.array(z.string().min(1).max(40)).optional().describe('Only return checkpoints carrying ALL of these tags.'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum entries to return (default 20).'),
        include_drafts: z.boolean().optional().describe('Include draft (uncommitted) checkpoints (default true).'),
        query: z.string().max(200).optional().describe('Case-insensitive substring match over title, remark, tags and context digest.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ tags_filter, limit, include_drafts, query }) => {
      try {
        const result = await service.listCheckpoints({
          tagsFilter: tags_filter,
          limit,
          includeDrafts: include_drafts,
          query,
        });
        const table = result.entries.length
          ? [
              '| id | status | created | commit | tags | title |',
              '| --- | --- | --- | --- | --- | --- |',
              ...result.entries.map(
                (entry) =>
                  `| \`${entry.id}\` | ${entry.status} | ${entry.createdAt} | ${entry.commitHash ? `\`${entry.commitHash.slice(0, 12)}\`` : '—'} | ${entry.tags.map((tag) => escapeCell(tag)).join(', ') || '—'} | ${escapeCell(entry.title)} |`,
              ),
            ].join('\n')
          : '_No checkpoints matched._';
        const markdown = [
          `## Checkpoints (${result.entries.length}/${result.total})`,
          '',
          table,
          result.truncated ? `\n_Showing the newest ${result.entries.length}; raise \`limit\` to see more._` : '',
        ]
          .filter((line) => line !== '')
          .join('\n');
        return textResult({ ok: true, data: result }, markdown);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 6. rollback_checkpoint -------------------------------------------------
  server.registerTool(
    'rollback_checkpoint',
    {
      title: 'Rollback to checkpoint (requires operator approval)',
      description:
        'HIGH RISK. Restore working-tree files to a checkpoint and return the captured agent context so the session can continue from that point. Without confirmation_id this call only returns a single-use token. Aborts with a conflict list when the working tree has uncommitted changes.',
      inputSchema: {
        checkpoint_id: z.string().min(2).describe('Checkpoint id (or a unique fragment).'),
        confirmation_id: z
          .string()
          .optional()
          .describe('Single-use token from a previous call to this tool, after explicit operator approval.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ checkpoint_id, confirmation_id }) => {
      try {
        const result = await service.rollbackCheckpoint({ checkpointId: checkpoint_id, confirmationId: confirmation_id });
        if (result.status === 'confirmation_required') {
          return pendingConfirmationResult(result);
        }
        if (result.status === 'conflict') {
          return conflictResult(result);
        }
        const markdown = [
          `## Rolled back to \`${result.checkpointId}\``,
          '',
          `**${result.checkpointTitle}**`,
          '',
          `- files restored: ${result.filesRestored}`,
          `- restored from: ${result.restoredFrom.commitHash ? `commit \`${result.restoredFrom.commitHash}\`` : `draft tree \`${result.restoredFrom.treeHash?.slice(0, 12)}\``}`,
          `- branch moved: ${result.branchMoved ? 'yes' : 'no'}`,
          `- context snapshot: \`${result.contextPath}\``,
          '',
          '**Restored agent context**',
          '',
          `\`\`\`\n${result.contextDigest}\n\`\`\``,
          '',
          result.rehydration,
          result.warnings.length > 0 ? `\n**Warnings**\n\n${result.warnings.map((warning) => `- ${warning}`).join('\n')}` : '',
        ]
          .filter((line) => line !== '')
          .join('\n');
        return textResult({ ok: true, data: result, warnings: result.warnings }, markdown);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 7. create_branch -------------------------------------------------------
  server.registerTool(
    'create_branch',
    {
      title: 'Create branch',
      description: 'Create a local branch at a checkpoint commit (or at HEAD when checkpoint_id is omitted). Does not switch branches. Local only: no remotes are touched.',
      inputSchema: {
        branch_name: z.string().min(1).max(100).describe('New branch name (validated with git check-ref-format).'),
        checkpoint_id: z.string().min(2).optional().describe('Checkpoint to branch from. Defaults to HEAD.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ branch_name, checkpoint_id }) => {
      try {
        const result = await service.createBranch({ branchName: branch_name, checkpointId: checkpoint_id });
        const markdown = [
          `## Branch \`${result.branch}\` created`,
          '',
          `- start point: \`${result.startPoint}\``,
          `- current HEAD still on: \`${result.head?.slice(0, 12) ?? '(none)'}\``,
          '',
          `Call switch_branch {branch_name:"${result.branch}"} to check it out.`,
        ].join('\n');
        return textResult({ ok: true, data: result }, markdown);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 8. switch_branch -------------------------------------------------------
  server.registerTool(
    'switch_branch',
    {
      title: 'Switch branch',
      description: 'Check out an existing local branch. Fails instead of forcing when the working tree has conflicting changes.',
      inputSchema: {
        branch_name: z.string().min(1).max(100).describe('Existing local branch to check out.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ branch_name }) => {
      try {
        const result = await service.switchBranch({ branchName: branch_name });
        const markdown = [
          `## Switched to \`${result.to}\``,
          '',
          `- from: \`${result.from ?? '(detached)'}\``,
          `- HEAD: \`${result.head?.slice(0, 12) ?? '(none)'}\``,
        ].join('\n');
        return textResult({ ok: true, data: result }, markdown);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // 9. get_status ----------------------------------------------------------
  server.registerTool(
    'get_status',
    {
      title: 'Get workspace status',
      description:
        'Report the working-tree diff status, current branch, recent commit, snapshot store contents (drafts/confirmed), effective policy and the newest checkpoint. Read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const result = await service.getStatus();
        const markdown = [
          `## Status of \`${result.workspace}\``,
          '',
          `- repository: ${result.repo.isRepo ? 'yes' : 'no'}`,
          `- branch: \`${result.repo.branch ?? '(detached)'}\``,
          `- HEAD: \`${result.repo.head?.slice(0, 12) ?? 'no commits yet'}\`${result.repo.headCommit ? ` — ${result.repo.headCommit.subject}` : ''}`,
          `- working tree: ${result.repo.isDirty ? 'dirty' : 'clean'}`,
          result.repo.changedFiles.length > 0
            ? `  - changed: ${result.repo.changedFiles.map((file) => `\`${file.status}\` ${file.path}`).join(', ')}`
            : '',
          result.repo.untrackedFiles.length > 0 ? `  - untracked: ${result.repo.untrackedFiles.slice(0, 20).join(', ')}` : '',
          `- checkpoints: ${result.store.confirmed} confirmed, ${result.store.drafts} draft(s)`,
          result.lastCheckpoint
            ? `- latest: \`${result.lastCheckpoint.id}\` (${result.lastCheckpoint.status}) — ${result.lastCheckpoint.title}`
            : '- latest: (none yet)',
          `- policy: auto_draft_on_milestone=${result.config.auto_draft_on_milestone}, max_draft_count=${result.config.max_draft_count}, ignore=${result.config.ignore_patterns.join(',')}`,
          `- pending confirmations: ${result.pendingConfirmations}`,
          result.hints.length > 0 ? `\n**Hints**\n\n${result.hints.map((hint) => `- ${hint}`).join('\n')}` : '',
        ]
          .filter((line) => line !== '')
          .join('\n');
        return textResult({ ok: true, data: result }, markdown);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

/** Shape a `confirmation_required` outcome for the model. */
function pendingConfirmationResult(
  challenge: {
    confirmationId: string;
    action: PendingConfirmation['action'];
    expiresAt: string;
    ttlSeconds: number;
    summary: string;
    details: Record<string, unknown>;
    message: string;
  },
): { content: ToolText[]; isError: true } {
  const markdown = [
    `## Confirmation required — nothing was executed`,
    '',
    `**${challenge.action}** would: ${challenge.summary}`,
    '',
    `Show this to the operator and wait for an explicit yes. If they approve, repeat this exact call with:`,
    '',
    '```json',
    JSON.stringify({ confirmation_id: challenge.confirmationId }, null, 2),
    '```',
    '',
    `The token is single-use and expires at ${challenge.expiresAt} (${challenge.ttlSeconds}s). It is bound to this exact request: changing the draft id or commit message invalidates it.`,
  ].join('\n');
  return {
    content: [
      {
        type: 'text',
        text: `${markdown}\n\n\`\`\`json\n${JSON.stringify({ ok: false, status: 'confirmation_required', ...challenge }, null, 2)}\n\`\`\``,
      },
    ],
    // Not an error in the MCP sense — the tool worked and needs approval — but
    // isError keeps agents from reading it as success on supported clients.
    isError: true,
  };
}

/** Shape a conflict outcome for the model. */
function conflictResult(conflict: {
  reason: string;
  message: string;
  conflicts: Record<string, unknown>;
  resolution: string[];
}): { content: ToolText[]; isError: true } {
  const markdown = [
    `## Conflict — operation aborted`,
    '',
    `${conflict.message} (\`${conflict.reason}\`)`,
    '',
    '**Conflicts**',
    '',
    '```json',
    JSON.stringify(conflict.conflicts, null, 2),
    '```',
    '',
    '**How to proceed**',
    '',
    conflict.resolution.map((step) => `- ${step}`).join('\n'),
    '',
    '_The plugin never resolves conflicts automatically._',
  ].join('\n');
  return {
    content: [ { type: 'text', text: `${markdown}\n\n\`\`\`json\n${JSON.stringify({ ok: false, status: 'conflict', ...conflict }, null, 2)}\n\`\`\`` } ],
    isError: true,
  };
}

/** Run the stdio transport. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let parsed: CliOptions | 'help';
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`dsh-agent-checkpoint: ${(error as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (parsed === 'help') {
    process.stdout.write(HELP);
    return;
  }

  const server = buildServer(parsed);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `dsh-agent-checkpoint ${VERSION} ready (workspace: ${path.resolve(parsed.workspace)}${parsed.sessionFile ? `, session: ${parsed.sessionFile}` : ''})\n`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`dsh-agent-checkpoint: received ${signal}, shutting down\n`);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const invokedDirectly = process.argv[1] !== undefined && /index\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`dsh-agent-checkpoint fatal: ${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
  });
}

export { CheckpointService };
