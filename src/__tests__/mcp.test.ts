/**
 * MCP transport tests: boot the real stdio server and talk to it like a client.
 *
 * These assertions cover the contract DSH depends on — tool names, annotations
 * and JSON payloads — rather than the service internals covered elsewhere.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { makeWorkspace, writeWorkspaceFile, type TempWorkspace } from './helpers.js';

const SERVER_ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));

const EXPECTED_TOOLS = [
  'init_workspace',
  'create_draft_checkpoint',
  'preview_checkpoint',
  'confirm_checkpoint',
  'list_checkpoints',
  'rollback_checkpoint',
  'create_branch',
  'switch_branch',
  'get_status',
];

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

interface Session {
  workspace: TempWorkspace;
  client: Client;
  call: (name: string, args: Record<string, unknown>) => Promise<{ result: ToolResult; payload: Record<string, unknown> }>;
  close: () => Promise<void>;
}

/** Extract the last fenced JSON block, which every tool appends as its payload. */
function payloadOf(result: ToolResult): Record<string, unknown> {
  const text = result.content.map((entry) => entry.text ?? '').join('\n');
  const blocks = [ ...text.matchAll(/```json\n([\s\S]*?)\n```/g) ];
  assert.ok(blocks.length > 0, `expected a fenced json payload in:\n${text}`);
  return JSON.parse(blocks[blocks.length - 1]![1]!) as Record<string, unknown>;
}

/** Spawn the server against a throwaway workspace and wait for the handshake. */
async function startServer(): Promise<Session> {
  const workspace = await makeWorkspace('ckpt-mcp-');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ SERVER_ENTRY, '--workspace', workspace.dir ],
    cwd: workspace.dir,
    env: { ...process.env, DSH_HOME: workspace.dshHome, DSH_SESSION_ID: '' } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ckpt-test-client', version: '1.0.0' });
  await client.connect(transport);
  return {
    workspace,
    client,
    call: async (name, args) => {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      return { result, payload: payloadOf(result) };
    },
    close: async () => {
      await client.close();
      await workspace.cleanup();
    },
  };
}

describe('mcp server', () => {
  it('exposes exactly the nine documented tools', async () => {
    const session = await startServer();
    try {
      const listed = await session.client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [ ...EXPECTED_TOOLS ].sort());
      for (const tool of listed.tools) {
        assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
        assert.equal(typeof tool.inputSchema, 'object', `${tool.name} needs an input schema`);
      }
      const byName = new Map(listed.tools.map((tool) => [ tool.name, tool ]));
      assert.equal(byName.get('confirm_checkpoint')?.annotations?.destructiveHint, true, 'confirm must be destructive');
      assert.equal(byName.get('rollback_checkpoint')?.annotations?.destructiveHint, true, 'rollback must be destructive');
      assert.equal(byName.get('get_status')?.annotations?.readOnlyHint, true, 'get_status is read-only');
      assert.equal(byName.get('list_checkpoints')?.annotations?.readOnlyHint, true, 'list_checkpoints is read-only');
      // Every tool can be pointed at another project without restarting the server.
      for (const tool of listed.tools) {
        const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
        assert.ok('workspace' in properties, `${tool.name} must accept an optional workspace argument`);
      }
      const required = (byName.get('get_status')?.inputSchema as { required?: string[] }).required ?? [];
      assert.ok(!required.includes('workspace'), 'workspace stays optional');
    } finally {
      await session.close();
    }
  });

  it('initialises a workspace and reports status over stdio', { timeout: 60_000 }, async () => {
    const session = await startServer();
    try {
      const init = await session.call('init_workspace', { workspace_path: session.workspace.dir });
      assert.notEqual(init.result.isError, true, 'init_workspace must succeed');
      assert.equal(init.payload.created, true);
      assert.equal(init.payload.branch, 'main');

      const status = await session.call('get_status', {});
      assert.notEqual(status.result.isError, true);
      const repo = status.payload.repo as Record<string, unknown>;
      assert.equal(repo.isRepo, true);
      assert.equal(repo.branch, 'main');
      const store = status.payload.store as Record<string, unknown>;
      assert.equal(store.drafts, 0);
    } finally {
      await session.close();
    }
  });

  it('refuses to commit without a confirmation token, then commits when given one', { timeout: 60_000 }, async () => {
    const session = await startServer();
    try {
      await session.call('init_workspace', { workspace_path: session.workspace.dir });
      await writeWorkspaceFile(session.workspace.dir, 'feature.md', '# feature\n');

      const draft = await session.call('create_draft_checkpoint', {
        title: 'feature milestone',
        tags: [ 'mcp' ],
        remark: 'transport test',
      });
      assert.notEqual(draft.result.isError, true);
      const draftId = draft.payload.draftId as string;
      assert.match(draftId, /^draft-/);
      assert.equal(draft.payload.status, 'draft');
      assert.equal(draft.payload.filesChanged, 2);

      // First confirm attempt must not commit; it returns a confirmation challenge.
      const challenge = await session.call('confirm_checkpoint', {
        draft_id: draftId,
        commit_message: 'checkpoint: feature milestone',
      });
      assert.equal(challenge.result.isError, true);
      assert.equal(challenge.payload.status, 'confirmation_required');
      const confirmationId = challenge.payload.confirmationId as string;
      assert.match(confirmationId, /^cfm-/);

      const confirmed = await session.call('confirm_checkpoint', {
        draft_id: draftId,
        commit_message: 'checkpoint: feature milestone',
        confirmation_id: confirmationId,
      });
      assert.notEqual(confirmed.result.isError, true);
      assert.equal(confirmed.payload.status, 'confirmed');
      const commitHash = confirmed.payload.commitHash as string;
      assert.match(commitHash, /^[0-9a-f]{40,64}$/);

      // The promoted record is reachable through its original draft id.
      const preview = await session.call('preview_checkpoint', { checkpoint_id: draftId });
      assert.notEqual(preview.result.isError, true);
      const record = preview.payload.checkpoint as Record<string, unknown>;
      assert.equal(record.status, 'confirmed');
      assert.equal(record.commitHash, commitHash);

      const listed = await session.call('list_checkpoints', { tags_filter: [ 'mcp' ] });
      const entries = listed.payload.entries as Array<Record<string, unknown>>;
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.id, confirmed.payload.checkpointId);
      assert.equal(entries[0]!.status, 'confirmed');
    } finally {
      await session.close();
    }
  });

  it('returns a conflict report instead of overwriting uncommitted work', { timeout: 60_000 }, async () => {
    const session = await startServer();
    try {
      await session.call('init_workspace', { workspace_path: session.workspace.dir });
      await writeWorkspaceFile(session.workspace.dir, 'work.txt', 'v1\n');
      const draft = await session.call('create_draft_checkpoint', { title: 'v1' });
      const challenge = await session.call('confirm_checkpoint', {
        draft_id: draft.payload.draftId as string,
        commit_message: 'checkpoint: v1',
      });
      const confirmed = await session.call('confirm_checkpoint', {
        draft_id: draft.payload.draftId as string,
        commit_message: 'checkpoint: v1',
        confirmation_id: challenge.payload.confirmationId as string,
      });
      assert.equal(confirmed.payload.status, 'confirmed');

      await writeWorkspaceFile(session.workspace.dir, 'work.txt', 'unsaved\n');
      const rollbackChallenge = await session.call('rollback_checkpoint', {
        checkpoint_id: confirmed.payload.checkpointId as string,
      });
      assert.equal(rollbackChallenge.payload.status, 'confirmation_required');

      const conflict = await session.call('rollback_checkpoint', {
        checkpoint_id: confirmed.payload.checkpointId as string,
        confirmation_id: rollbackChallenge.payload.confirmationId as string,
      });
      assert.equal(conflict.result.isError, true);
      assert.equal(conflict.payload.status, 'conflict');
      assert.equal(conflict.payload.reason, 'worktree_dirty');
    } finally {
      await session.close();
    }
  });

  it('returns structured errors instead of crashing', { timeout: 60_000 }, async () => {
    const session = await startServer();
    try {
      const preview = await session.call('preview_checkpoint', { checkpoint_id: 'draft-0000000000-deadbeef' });
      assert.equal(preview.result.isError, true);
      const error = preview.payload.error as Record<string, unknown>;
      assert.equal(error.code, 'checkpoint_not_found');

      const invalid = await session.call('switch_branch', { branch_name: 'nope' });
      assert.equal(invalid.result.isError, true);
      assert.equal((invalid.payload.error as Record<string, unknown>).code, 'not_a_git_repo');
    } finally {
      await session.close();
    }
  });
});
