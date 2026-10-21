/**
 * End-to-end tests for the checkpoint service against real git repositories.
 *
 * Every test gets a throwaway workspace so the suite never touches the
 * repository it runs in, and `DSH_HOME` points at an empty temp dir so the
 * agent-context capture path is exercised without a live session.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { CheckpointService, CheckpointError } from '../checkpoint.js';
import type { ConfirmationChallenge, ConfirmResult, ConflictReport, RollbackResult } from '../checkpoint.js';
import { gitOut, headHash, headSubject, makeWorkspace, writeWorkspaceFile, type TempWorkspace } from './helpers.js';

type AnyResult = ConfirmResult | ConfirmationChallenge | ConflictReport | RollbackResult;

/** Narrow a confirm/rollback result down to the confirmation challenge. */
function asChallenge(value: AnyResult): ConfirmationChallenge {
  assert.equal(value.status, 'confirmation_required', `expected a confirmation challenge, got ${value.status}`);
  return value as ConfirmationChallenge;
}

/** Narrow a confirm result down to the committed snapshot. */
function asConfirm(value: AnyResult): ConfirmResult {
  assert.equal(value.status, 'confirmed', `expected a confirmed result, got ${value.status}`);
  return value as ConfirmResult;
}

/** Narrow a rollback result down to the restored snapshot. */
function asRollback(value: AnyResult): RollbackResult {
  assert.equal(value.status, 'rolled_back', `expected a rolled_back result, got ${value.status}`);
  return value as RollbackResult;
}

/** Narrow a confirm/rollback result down to a conflict report. */
function asConflict(value: AnyResult): ConflictReport {
  assert.equal(value.status, 'conflict', `expected a conflict result, got ${value.status}`);
  return value as ConflictReport;
}

/** Assert that a promise rejects with a specific CheckpointError code. */
async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<CheckpointError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CheckpointError, `expected CheckpointError, got ${String(error)}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected rejection with code ${code}, but the promise resolved`);
}

/** Create a workspace, run init_workspace, and return the service. */
async function initWorkspace(): Promise<{ workspace: TempWorkspace; service: CheckpointService }> {
  const workspace = await makeWorkspace('ckpt-service-');
  const service = new CheckpointService(workspace.dir);
  await service.initWorkspace(workspace.dir);
  return { workspace, service };
}

/** Commit everything currently in the worktree. */
async function commitAll(dir: string, message: string): Promise<string> {
  await gitOut(dir, [ 'add', '-A' ]);
  await gitOut(dir, [ 'commit', '-m', message ]);
  return (await headHash(dir)) as string;
}

/** Confirm a draft through the full two-phase handshake. */
async function confirmDraft(service: CheckpointService, draftId: string, message: string): Promise<ConfirmResult> {
  const challenge = asChallenge(await service.confirmCheckpoint({ draftId, commitMessage: message }));
  return asConfirm(
    await service.confirmCheckpoint({ draftId, commitMessage: message, confirmationId: challenge.confirmationId }),
  );
}

describe('init_workspace', () => {
  it('creates a repository, ignore rules and the checkpoint store', async () => {
    const workspace = await makeWorkspace('ckpt-init-');
    try {
      const service = new CheckpointService(workspace.dir);
      const first = await service.initWorkspace(workspace.dir);
      assert.equal(first.created, true);
      assert.equal(first.gitAvailable, true);
      assert.match(first.gitVersion ?? '', /git version \d+\.\d+/);
      assert.equal(first.branch, 'main');
      assert.equal(first.head, null);
      assert.ok(first.gitignoreUpdated);
      assert.ok(first.excludeUpdated);

      const gitignore = await readFile(path.join(workspace.dir, '.gitignore'), 'utf8');
      assert.match(gitignore, /\.dsh-checkpoint\//);

      const exclude = await readFile(path.join(workspace.dir, '.git', 'info', 'exclude'), 'utf8');
      assert.match(exclude, /dsh-agent-checkpoint managed block/);
      assert.match(exclude, /node_modules/);

      const second = await service.initWorkspace(workspace.dir);
      assert.equal(second.created, false);
      assert.equal(second.gitignoreUpdated, false);
      assert.equal(second.excludeUpdated, false);
    } finally {
      await workspace.cleanup();
    }
  });

  it('refuses to initialise a directory inside an existing repository', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      const nested = path.join(workspace.dir, 'packages', 'inner');
      await writeWorkspaceFile(workspace.dir, 'packages/inner/index.ts', 'export {};\n');
      const error = await rejectsWithCode(service.initWorkspace(nested), 'nested_repository');
      assert.match(error.message, /repository/i);
    } finally {
      await workspace.cleanup();
    }
  });
});

describe('create_draft_checkpoint', () => {
  it('captures the worktree without committing or moving HEAD', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await writeWorkspaceFile(workspace.dir, 'notes.md', '# plan\n');
      await writeWorkspaceFile(workspace.dir, 'src/app.ts', 'export const x = 1;\n');
      const draft = await service.createDraft({ title: 'first milestone', tags: [ 'alpha' ], remark: 'after scaffolding' });

      assert.equal(draft.status, 'draft');
      // init_workspace itself adds an untracked .gitignore, so it is part of the draft.
      assert.equal(draft.filesChanged, 3);
      assert.deepEqual(draft.files.map((file) => file.path).sort(), [ '.gitignore', 'notes.md', 'src/app.ts' ]);
      assert.equal(await headHash(workspace.dir), null, 'HEAD must not move');
      assert.equal(await headSubject(workspace.dir), null, 'no commit must be created');
      assert.match(draft.treeHash ?? '', /^[0-9a-f]{40,64}$/);
      assert.ok(draft.diffStat.length > 0);

      const anchored = await gitOut(workspace.dir, [ 'rev-parse', '--verify', `refs/dsh-checkpoint/drafts/${draft.draftId}` ]);
      assert.match(anchored, /^[0-9a-f]{40,64}$/, 'the draft commit object must be anchored against gc');

      const stored = await service.record(draft.draftId);
      assert.equal(stored?.status, 'draft');
      assert.equal(stored?.commitHash, null);
      assert.equal(stored?.tags[0], 'alpha');
      // The store itself must never show up as a captured file.
      assert.ok(!draft.files.some((file) => file.path.startsWith('.dsh-checkpoint/')));
    } finally {
      await workspace.cleanup();
    }
  });

  it('reports nothing_to_checkpoint on a clean repository with no agent context', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await commitAll(workspace.dir, 'baseline');
      const error = await rejectsWithCode(service.createDraft({ title: 'empty' }), 'nothing_to_checkpoint');
      assert.match(error.message, /no file changes/i);
    } finally {
      await workspace.cleanup();
    }
  });

  it('requires init_workspace before capturing', async () => {
    const workspace = await makeWorkspace('ckpt-norepo-');
    try {
      await writeWorkspaceFile(workspace.dir, 'file.txt', 'x\n');
      const service = new CheckpointService(workspace.dir);
      await rejectsWithCode(service.createDraft({ title: 'nope' }), 'not_a_git_repo');
    } finally {
      await workspace.cleanup();
    }
  });

  it('honours max_draft_count by dropping the oldest drafts only', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await writeWorkspaceFile(workspace.dir, 'checkpoint.config.json', JSON.stringify({ max_draft_count: 2 }));
      const first = await service.createDraft({ title: 'one' });
      await writeWorkspaceFile(workspace.dir, 'a.txt', 'a\n');
      const second = await service.createDraft({ title: 'two' });
      await writeWorkspaceFile(workspace.dir, 'b.txt', 'b\n');
      const third = await service.createDraft({ title: 'three' });

      assert.deepEqual(third.trimmedDrafts, [ first.draftId ]);
      assert.match(third.warnings.join('\n'), /retention limit/);
      const listed = await service.listCheckpoints({ limit: 10 });
      const draftIds = listed.entries
        .filter((entry) => entry.status === 'draft')
        .map((entry) => entry.id)
        .sort();
      assert.deepEqual(draftIds, [ second.draftId, third.draftId ].sort());
    } finally {
      await workspace.cleanup();
    }
  });
});

describe('confirm_checkpoint', () => {
  it('only commits after presenting an explicit confirmation token', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await writeWorkspaceFile(workspace.dir, 'hello.txt', 'hello\n');
      const draft = await service.createDraft({ title: 'ready to commit' });

      const challenge = asChallenge(
        await service.confirmCheckpoint({ draftId: draft.draftId, commitMessage: 'checkpoint: hello' }),
      );
      assert.match(challenge.confirmationId, /^cfm-[0-9a-f]{16,}$/);
      assert.match(challenge.summary, /git commit/);
      assert.equal(await headHash(workspace.dir), null, 'no commit before the operator confirms');

      // A token minted for one message must not authorise another message.
      await rejectsWithCode(
        service.confirmCheckpoint({
          draftId: draft.draftId,
          commitMessage: 'something else',
          confirmationId: challenge.confirmationId,
        }),
        'confirmation_mismatch',
      );

      const confirmed = asConfirm(
        await service.confirmCheckpoint({
          draftId: draft.draftId,
          commitMessage: 'checkpoint: hello',
          confirmationId: challenge.confirmationId,
        }),
      );
      assert.match(confirmed.commitHash ?? '', /^[0-9a-f]{40,64}$/);
      assert.equal(await headSubject(workspace.dir), 'checkpoint: hello');

      // The original draft id keeps working as an alias for the promoted record.
      const preview = await service.previewCheckpoint({ checkpointId: draft.draftId });
      assert.equal(preview.checkpoint.id, confirmed.checkpointId);
      assert.equal(preview.checkpoint.status, 'confirmed');
      assert.equal(preview.checkpoint.commitHash, confirmed.commitHash);

      // A draft that was already promoted cannot be confirmed twice.
      await rejectsWithCode(
        service.confirmCheckpoint({
          draftId: draft.draftId,
          commitMessage: 'checkpoint: hello',
          confirmationId: challenge.confirmationId,
        }),
        'already_confirmed',
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it('refuses to confirm when the worktree drifted after the draft', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await writeWorkspaceFile(workspace.dir, 'app.txt', 'version 1\n');
      const draft = await service.createDraft({ title: 'v1' });
      const challenge = asChallenge(
        await service.confirmCheckpoint({ draftId: draft.draftId, commitMessage: 'checkpoint: v1' }),
      );

      await writeWorkspaceFile(workspace.dir, 'app.txt', 'version 2\n');
      const conflict = asConflict(
        await service.confirmCheckpoint({
          draftId: draft.draftId,
          commitMessage: 'checkpoint: v1',
          confirmationId: challenge.confirmationId,
        }),
      );
      assert.equal(conflict.reason, 'worktree_changed');
      assert.ok(conflict.conflicts && 'files' in conflict.conflicts);
      assert.equal(await headHash(workspace.dir), null, 'a conflicted confirm must not commit');
    } finally {
      await workspace.cleanup();
    }
  });

  it('refuses to confirm when HEAD moved after the draft', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await writeWorkspaceFile(workspace.dir, 'app.txt', 'version 1\n');
      const draft = await service.createDraft({ title: 'v1' });
      const challenge = asChallenge(
        await service.confirmCheckpoint({ draftId: draft.draftId, commitMessage: 'checkpoint: v1' }),
      );
      await commitAll(workspace.dir, 'unrelated commit');
      const movedHead = await headHash(workspace.dir);

      const conflict = asConflict(
        await service.confirmCheckpoint({
          draftId: draft.draftId,
          commitMessage: 'checkpoint: v1',
          confirmationId: challenge.confirmationId,
        }),
      );
      assert.equal(conflict.reason, 'head_moved');
      assert.equal(await headHash(workspace.dir), movedHead, 'history must be untouched');
    } finally {
      await workspace.cleanup();
    }
  });
});

describe('rollback_checkpoint', () => {
  it('restores files and moves the branch for a confirmed checkpoint', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await writeWorkspaceFile(workspace.dir, 'hello.txt', 'one\n');
      const draft = await service.createDraft({ title: 'baseline' });
      const confirmed = await confirmDraft(service, draft.draftId, 'checkpoint: baseline');

      await writeWorkspaceFile(workspace.dir, 'hello.txt', 'two\n');
      const later = await commitAll(workspace.dir, 'second commit');
      assert.notEqual(later, confirmed.commitHash);

      const challenge = asChallenge(await service.rollbackCheckpoint({ checkpointId: confirmed.checkpointId }));
      assert.match(challenge.summary, /discard uncommitted changes/);

      const rolled = asRollback(
        await service.rollbackCheckpoint({
          checkpointId: confirmed.checkpointId,
          confirmationId: challenge.confirmationId,
        }),
      );
      assert.equal(rolled.branchMoved, true);
      assert.equal(await readFile(path.join(workspace.dir, 'hello.txt'), 'utf8'), 'one\n');
      assert.equal(await headHash(workspace.dir), confirmed.commitHash);
      assert.ok(rolled.rehydration.length > 0);
    } finally {
      await workspace.cleanup();
    }
  });

  it('aborts on a dirty worktree and lists the conflicting files', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await writeWorkspaceFile(workspace.dir, 'hello.txt', 'one\n');
      const draft = await service.createDraft({ title: 'baseline' });
      const confirmed = await confirmDraft(service, draft.draftId, 'checkpoint: baseline');

      await writeWorkspaceFile(workspace.dir, 'hello.txt', 'unsaved work\n');
      await writeWorkspaceFile(workspace.dir, 'scratch.txt', 'untracked\n');

      const challenge = asChallenge(await service.rollbackCheckpoint({ checkpointId: confirmed.checkpointId }));
      const conflict = asConflict(
        await service.rollbackCheckpoint({
          checkpointId: confirmed.checkpointId,
          confirmationId: challenge.confirmationId,
        }),
      );
      assert.equal(conflict.reason, 'worktree_dirty');
      assert.ok(conflict.conflicts && 'modified' in conflict.conflicts);
      assert.deepEqual(
        (conflict.conflicts.modified as Array<{ path: string }>).map((file) => file.path),
        [ 'hello.txt' ],
      );
      assert.deepEqual(conflict.conflicts.untracked, [ 'scratch.txt' ]);
      assert.equal(
        await readFile(path.join(workspace.dir, 'hello.txt'), 'utf8'),
        'unsaved work\n',
        'no work may be discarded',
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it('restores a draft tree without moving the branch', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await writeWorkspaceFile(workspace.dir, 'base.txt', 'base\n');
      await commitAll(workspace.dir, 'baseline');

      await writeWorkspaceFile(workspace.dir, 'draft.txt', 'draft-content\n');
      const draft = await service.createDraft({ title: 'draft only' });

      await writeWorkspaceFile(workspace.dir, 'draft.txt', 'later-content\n');
      const later = await commitAll(workspace.dir, 'later work');

      const challenge = asChallenge(await service.rollbackCheckpoint({ checkpointId: draft.draftId }));
      assert.match(challenge.summary, /branch is not moved/i);
      const rolled = asRollback(
        await service.rollbackCheckpoint({
          checkpointId: draft.draftId,
          confirmationId: challenge.confirmationId,
        }),
      );
      assert.equal(rolled.branchMoved, false);
      assert.equal(await readFile(path.join(workspace.dir, 'draft.txt'), 'utf8'), 'draft-content\n');
      assert.equal(await headHash(workspace.dir), later, 'a draft rollback never rewrites history');
    } finally {
      await workspace.cleanup();
    }
  });

  it('reports checkpoint_not_found for unknown ids', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await rejectsWithCode(
        service.rollbackCheckpoint({ checkpointId: 'draft-0000000000-deadbeef' }),
        'checkpoint_not_found',
      );
    } finally {
      await workspace.cleanup();
    }
  });
});

describe('list_checkpoints', () => {
  it('filters by tag, honours the limit and orders newest first', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await writeWorkspaceFile(workspace.dir, 'a.txt', 'a\n');
      const one = await service.createDraft({ title: 'alpha one', tags: [ 'alpha' ] });
      await writeWorkspaceFile(workspace.dir, 'b.txt', 'b\n');
      await service.createDraft({ title: 'beta two', tags: [ 'beta' ] });
      await writeWorkspaceFile(workspace.dir, 'c.txt', 'c\n');
      const three = await service.createDraft({ title: 'alpha three', tags: [ 'alpha', 'release' ] });

      const filtered = await service.listCheckpoints({ tagsFilter: [ 'alpha' ] });
      assert.equal(filtered.total, 2);
      assert.deepEqual(filtered.entries.map((entry) => entry.id), [ three.draftId, one.draftId ]);
      assert.equal(filtered.entries[0]?.tags.includes('release'), true);

      const limited = await service.listCheckpoints({ limit: 1 });
      assert.equal(limited.entries.length, 1);
      assert.equal(limited.truncated, true);
      assert.equal(limited.entries[0]?.id, three.draftId);

      const draftsOnly = await service.listCheckpoints({ includeDrafts: false });
      assert.equal(draftsOnly.total, 0);
    } finally {
      await workspace.cleanup();
    }
  });
});

describe('branches', () => {
  it('creates a branch at a checkpoint and switches to it', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await writeWorkspaceFile(workspace.dir, 'app.txt', 'one\n');
      const draft = await service.createDraft({ title: 'base' });
      const confirmed = await confirmDraft(service, draft.draftId, 'checkpoint: base');

      const created = await service.createBranch({
        branchName: 'recover-milestone',
        checkpointId: confirmed.checkpointId,
      });
      assert.equal(created.branch, 'recover-milestone');
      assert.equal(created.startPoint, confirmed.commitHash);
      assert.equal(created.checkedOut, false);

      const switched = await service.switchBranch({ branchName: 'recover-milestone' });
      assert.equal(switched.to, 'recover-milestone');
      assert.equal(await gitOut(workspace.dir, [ 'rev-parse', '--abbrev-ref', 'HEAD' ]), 'recover-milestone');

      await rejectsWithCode(service.switchBranch({ branchName: 'does-not-exist' }), 'branch_not_found');
      await rejectsWithCode(service.createBranch({ branchName: 'bad name' }), 'invalid_branch_name');
      await rejectsWithCode(service.createBranch({ branchName: 'recover-milestone' }), 'branch_exists');
    } finally {
      await workspace.cleanup();
    }
  });

  it('refuses to create a branch before the first commit', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await writeWorkspaceFile(workspace.dir, 'app.txt', 'one\n');
      await rejectsWithCode(service.createBranch({ branchName: 'feature' }), 'no_commits');
    } finally {
      await workspace.cleanup();
    }
  });
});

describe('get_status', () => {
  it('reports repository state and the checkpoint store summary', async () => {
    const { workspace, service } = await initWorkspace();
    try {
      await writeWorkspaceFile(workspace.dir, 'app.txt', 'one\n');
      const draft = await service.createDraft({ title: 'wip' });

      const status = await service.getStatus();
      assert.equal(status.repo.isRepo, true);
      assert.equal(status.repo.branch, 'main');
      assert.equal(status.repo.isDirty, true);
      assert.deepEqual(status.repo.untrackedFiles.sort(), [ '.gitignore', 'app.txt' ].sort());
      assert.equal(status.store.drafts, 1);
      assert.equal(status.store.confirmed, 0);
      assert.equal(status.git.available, true);
      assert.equal(status.configFile.found, false);
      assert.equal(status.lastCheckpoint?.id, draft.draftId);
      assert.ok(status.hints.some((hint) => hint.includes('create_draft_checkpoint')));

      await confirmDraft(service, draft.draftId, 'checkpoint: wip');
      const after = await service.getStatus();
      assert.equal(after.store.drafts, 0);
      assert.equal(after.store.confirmed, 1);
      assert.equal(after.repo.isDirty, false);
      assert.equal(after.repo.headCommit?.subject, 'checkpoint: wip');
    } finally {
      await workspace.cleanup();
    }
  });

  it('works on a directory that is not a repository yet', async () => {
    const workspace = await makeWorkspace('ckpt-status-');
    try {
      const service = new CheckpointService(workspace.dir);
      const status = await service.getStatus();
      assert.equal(status.repo.isRepo, false);
      assert.equal(status.store.drafts, 0);
      assert.ok(status.hints.some((hint) => hint.includes('init_workspace')));
      assert.equal(
        await readFile(path.join(workspace.dir, 'checkpoint.config.json'), 'utf8').catch(() => null),
        null,
      );
    } finally {
      await workspace.cleanup();
    }
  });
});
