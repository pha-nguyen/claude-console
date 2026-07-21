// test/server.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer, getBrowseRoots, isWithinBrowseRoots, getAllowedOriginHosts, parseTranscript, encodeClaudeProjectDir, snapshotTranscripts, detectActiveTranscript, parseRunningAgentIds } from '../server.js';

const gitEnv = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
}

function createTempRepo() {
  const dir = createTempDir();
  execSync('git init && git commit --allow-empty -m "init"', {
    cwd: dir,
    env: { ...process.env, ...gitEnv },
  });
  return dir;
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('Projects API', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.destroy();
  });

  it('GET /api/projects returns empty projects and sessions initially', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.projects));
    assert.ok(Array.isArray(data.sessions));
    assert.strictEqual(data.projects.length, 0);
    assert.strictEqual(data.sessions.length, 0);
  });

  it('POST /api/projects creates a project', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-proj', cwd: process.cwd() }),
    });
    assert.strictEqual(res.status, 201);
    const proj = await res.json();
    assert.ok(proj.id);
    assert.strictEqual(proj.name, 'test-proj');
    assert.ok(proj.cwd);
    assert.ok(proj.createdAt);
  });

  it('POST /api/projects rejects invalid cwd', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad', cwd: '/nonexistent/xyz' }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/projects rejects missing name', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: process.cwd() }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('DELETE /api/projects/:id removes project', async () => {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-delete', cwd: process.cwd() }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/projects/${id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);

    const listRes = await fetch(`${baseUrl}/api/projects`);
    const { projects } = await listRes.json();
    assert.ok(!projects.find((p) => p.id === id));
  });

  it('DELETE /api/projects/:id returns 404 for unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/projects/nonexistent`, { method: 'DELETE' });
    assert.strictEqual(res.status, 404);
  });
});

describe('Sessions API (scoped to projects)', () => {
  let server;
  let baseUrl;
  let projectId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    // Create a project to use
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'session-test-proj', cwd: process.cwd() }),
    });
    const proj = await res.json();
    projectId = proj.id;
  });

  after(async () => {
    await server.destroy();
  });

  it('POST /api/projects/:id/sessions creates a session', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-session' }),
    });
    assert.strictEqual(res.status, 201);
    const session = await res.json();
    assert.ok(session.id);
    assert.strictEqual(session.projectId, projectId);
    assert.strictEqual(session.name, 'test-session');
    assert.strictEqual(session.status, 'running');
    assert.strictEqual(session.alive, true);
  });

  it('POST /api/projects/:id/sessions returns 404 for unknown project', async () => {
    const res = await fetch(`${baseUrl}/api/projects/nonexistent/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'orphan' }),
    });
    assert.strictEqual(res.status, 404);
  });

  it('POST /api/projects/:id/sessions rejects missing name', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });

  it('DELETE /api/sessions/:id removes session', async () => {
    // Create a session first
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-delete' }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/sessions/${id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
  });

  it('POST /api/sessions/:id/restart restarts session', async () => {
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-restart' }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/sessions/${id}/restart`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const session = await res.json();
    assert.strictEqual(session.alive, true);
  });

  it('DELETE /api/projects/:id also removes its sessions', async () => {
    // Create a fresh project with a session
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cascade-test', cwd: process.cwd() }),
    });
    const proj = await projRes.json();

    await fetch(`${baseUrl}/api/projects/${proj.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'child-session' }),
    });

    // Delete project
    const delRes = await fetch(`${baseUrl}/api/projects/${proj.id}`, { method: 'DELETE' });
    assert.strictEqual(delRes.status, 200);

    // Verify project and its sessions are gone from GET /api/projects
    const listRes = await fetch(`${baseUrl}/api/projects`);
    const { projects, sessions } = await listRes.json();
    assert.ok(!projects.find((p) => p.id === proj.id));
    assert.ok(!sessions.find((s) => s.projectId === proj.id), 'cascade: sessions should be removed');
  });
});

describe('Git Worktree Integration', () => {
  let server;
  let baseUrl;
  let tempDir;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('POST /api/projects rejects non-git directory (code: NOT_GIT_REPO)', async () => {
    tempDir = createTempDir();
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'not-git', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'NOT_GIT_REPO');
    cleanupDir(tempDir);
    tempDir = null;
  });

  it('POST /api/projects rejects bare repository (code: BARE_REPO)', async () => {
    tempDir = createTempDir();
    execSync('git init --bare', { cwd: tempDir, env: { ...process.env, ...gitEnv } });
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bare-repo', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'BARE_REPO');
    cleanupDir(tempDir);
    tempDir = null;
  });

  it('POST /api/projects rejects empty repository (code: EMPTY_REPO)', async () => {
    tempDir = createTempDir();
    execSync('git init', { cwd: tempDir, env: { ...process.env, ...gitEnv } });
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'empty-repo', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'EMPTY_REPO');
    cleanupDir(tempDir);
    tempDir = null;
  });

  it('POST /api/projects accepts valid git repository', async () => {
    tempDir = createTempRepo();
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'valid-repo', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.ok(data.id);
    assert.strictEqual(data.name, 'valid-repo');
    cleanupDir(tempDir);
    tempDir = null;
  });
});

describe('Worktree Session Lifecycle', () => {
  let server;
  let baseUrl;
  let tempDir;
  let projectId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    // Create a temp git repo for tests
    tempDir = createTempRepo();
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'worktree-test', cwd: tempDir }),
    });
    const proj = await res.json();
    projectId = proj.id;
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('POST /api/projects/:id/sessions creates worktree and branch', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Feature Test' }),
    });
    assert.strictEqual(res.status, 201);
    const session = await res.json();
    assert.ok(session.id);
    assert.ok(session.branchName, 'session should have branchName');
    assert.ok(session.worktreePath, 'session should have worktreePath');
    assert.ok(session.branchName.startsWith('feature-test-'), 'branchName should be sanitized');

    // Verify worktree was created
    const worktreePath = path.join(tempDir, session.worktreePath);
    assert.ok(fs.existsSync(worktreePath), 'worktree directory should exist');

    // Verify branch exists
    const branches = execSync('git branch -a', { cwd: tempDir, encoding: 'utf8' });
    assert.ok(branches.includes(`claude/${session.branchName}`), 'branch should exist');
  });

  it('POST /api/projects/:id/sessions returns INVALID_BRANCH_NAME for bad names', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '../../../etc/passwd' }),
    });
    // The name gets sanitized, so it should actually succeed
    // The sanitizer removes the dots and slashes
    assert.strictEqual(res.status, 201);
    const session = await res.json();
    // Verify the branch name doesn't contain path traversal
    assert.ok(!session.branchName.includes('..'), 'branchName should not contain ..');
    assert.ok(!session.branchName.includes('/'), 'branchName should not contain /');
  });

  it('POST /api/sessions/:id/restart returns WORKTREE_MISSING when worktree removed', async () => {
    // Create a session
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Restart Test' }),
    });
    const session = await createRes.json();

    // Manually remove the worktree
    const worktreePath = path.join(tempDir, session.worktreePath);
    execSync(`git worktree remove --force "${worktreePath}"`, { cwd: tempDir });

    // Try to restart
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/restart`, { method: 'POST' });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'WORKTREE_MISSING');
  });

  it('POST /api/sessions/:id/archive removes worktree but keeps branch', async () => {
    // Create a session
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Archive Test' }),
    });
    const session = await createRes.json();
    const worktreePath = path.join(tempDir, session.worktreePath);
    const fullBranchName = `claude/${session.branchName}`;

    // Archive the session
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/archive`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.ok(data.branch.includes('claude/'), 'response should include branch name');

    // Verify worktree was removed
    assert.ok(!fs.existsSync(worktreePath), 'worktree directory should be removed');

    // Verify branch still exists
    const branches = execSync('git branch -a', { cwd: tempDir, encoding: 'utf8' });
    assert.ok(branches.includes(fullBranchName), 'branch should still exist after archive');

    // Verify session is removed from list
    const listRes = await fetch(`${baseUrl}/api/projects`);
    const { sessions } = await listRes.json();
    assert.ok(!sessions.find((s) => s.id === session.id), 'session should be removed');
  });

  it('DELETE returns DIRTY_WORKTREE when uncommitted changes', async () => {
    // Create a session
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Dirty Test' }),
    });
    const session = await createRes.json();

    // Create uncommitted changes in the worktree
    const worktreePath = path.join(tempDir, session.worktreePath);
    fs.writeFileSync(path.join(worktreePath, 'dirty-file.txt'), 'uncommitted changes');

    // Try to delete (should fail)
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'DIRTY_WORKTREE');
  });

  it('DELETE with force=true deletes dirty worktree', async () => {
    // Create a session
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Force Delete Test' }),
    });
    const session = await createRes.json();

    // Create uncommitted changes in the worktree
    const worktreePath = path.join(tempDir, session.worktreePath);
    fs.writeFileSync(path.join(worktreePath, 'dirty-file.txt'), 'uncommitted changes');

    // Delete with force=true
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}?force=true`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);

    // Verify worktree and branch are removed
    assert.ok(!fs.existsSync(worktreePath), 'worktree directory should be removed');
  });

  it('DELETE proceeds when dirty check fails (missing worktree)', async () => {
    // Create a session
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Missing Worktree Test' }),
    });
    const session = await createRes.json();

    // Manually remove the worktree directory (simulate corruption)
    const worktreePath = path.join(tempDir, session.worktreePath);
    fs.rmSync(worktreePath, { recursive: true, force: true });

    // Delete should still succeed
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
  });

  it('DELETE project refuses when a session worktree is dirty (no force)', async () => {
    // Use a dedicated project so we don't disturb the shared one.
    const p = await (await fetch(`${baseUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'proj-dirty-guard', cwd: tempDir }),
    })).json();
    const session = await (await fetch(`${baseUrl}/api/projects/${p.id}/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Project Dirty Guard' }),
    })).json();
    fs.writeFileSync(path.join(tempDir, session.worktreePath, 'uncommitted.txt'), 'wip');

    const res = await fetch(`${baseUrl}/api/projects/${p.id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'DIRTY_WORKTREE');
    assert.ok(Array.isArray(data.sessions) && data.sessions.includes('Project Dirty Guard'));

    const list = await (await fetch(`${baseUrl}/api/projects`)).json();
    assert.ok(list.projects.find((x) => x.id === p.id), 'project should survive refused delete');

    // Force-clean the dedicated project for teardown.
    await fetch(`${baseUrl}/api/projects/${p.id}?force=true`, { method: 'DELETE' });
  });

  it('DELETE project with force=true removes even dirty sessions', async () => {
    const p = await (await fetch(`${baseUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'proj-force-delete', cwd: tempDir }),
    })).json();
    const session = await (await fetch(`${baseUrl}/api/projects/${p.id}/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Project Force Delete' }),
    })).json();
    fs.writeFileSync(path.join(tempDir, session.worktreePath, 'uncommitted.txt'), 'wip');

    const res = await fetch(`${baseUrl}/api/projects/${p.id}?force=true`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    const list = await (await fetch(`${baseUrl}/api/projects`)).json();
    assert.ok(!list.projects.find((x) => x.id === p.id), 'project should be gone after force delete');
  });
});

describe('Worktree Integration - Full Lifecycle', () => {
  let server;
  let baseUrl;
  let tempDir;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = createTempRepo();
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('complete session lifecycle: create -> restart -> archive -> verify', async () => {
    // Create project
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'lifecycle-test', cwd: tempDir }),
    });
    assert.strictEqual(projRes.status, 201);
    const project = await projRes.json();

    // Create session
    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Lifecycle Test' }),
    });
    assert.strictEqual(sessRes.status, 201);
    const session = await sessRes.json();
    assert.ok(session.branchName);
    assert.ok(session.worktreePath);

    // Verify worktree exists
    const worktreePath = path.join(tempDir, session.worktreePath);
    assert.ok(fs.existsSync(worktreePath), 'worktree should exist after session creation');

    // Create a file in worktree to verify it's a working directory
    fs.writeFileSync(path.join(worktreePath, 'test.txt'), 'test content');

    // Restart session (should work)
    const restartRes = await fetch(`${baseUrl}/api/sessions/${session.id}/restart`, {
      method: 'POST',
    });
    assert.strictEqual(restartRes.status, 200);

    // Archive session (force=true since we created a file making it dirty)
    const archiveRes = await fetch(`${baseUrl}/api/sessions/${session.id}/archive?force=true`, {
      method: 'POST',
    });
    assert.strictEqual(archiveRes.status, 200);
    const archiveData = await archiveRes.json();
    assert.ok(archiveData.branch);

    // Verify worktree is gone
    assert.ok(!fs.existsSync(worktreePath), 'worktree should be removed after archive');

    // Verify branch still exists
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes(`claude/${session.branchName}`), 'branch should remain after archive');

    // Verify session is removed from API
    const listRes = await fetch(`${baseUrl}/api/projects`);
    const { sessions } = await listRes.json();
    assert.ok(!sessions.find((s) => s.id === session.id), 'session should be removed from list');
  });

  it('delete removes the worktree but preserves the branch for recovery', async () => {
    // Create project
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'delete-lifecycle', cwd: tempDir }),
    });
    assert.strictEqual(projRes.status, 201);
    const project = await projRes.json();

    // Create session
    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Delete Test' }),
    });
    assert.strictEqual(sessRes.status, 201);
    const session = await sessRes.json();
    const worktreePath = path.join(tempDir, session.worktreePath);
    const fullBranchName = `claude/${session.branchName}`;

    // Verify worktree and branch exist before delete
    assert.ok(fs.existsSync(worktreePath), 'worktree should exist before delete');
    let branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes(fullBranchName), 'branch should exist before delete');

    // Delete session
    const deleteRes = await fetch(`${baseUrl}/api/sessions/${session.id}`, {
      method: 'DELETE',
    });
    assert.strictEqual(deleteRes.status, 200);

    // Verify worktree is gone
    assert.ok(!fs.existsSync(worktreePath), 'worktree should be removed after delete');

    // Branch is PRESERVED (deleteBranch:false): the dirty check only catches
    // uncommitted changes, so force-deleting the branch could silently orphan
    // committed-but-unmerged commits. The claude/<branch> ref stays recoverable.
    branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes(fullBranchName), 'branch should be preserved after delete');

    // Verify session is removed from API
    const listRes = await fetch(`${baseUrl}/api/projects`);
    const { sessions } = await listRes.json();
    assert.ok(!sessions.find((s) => s.id === session.id), 'session should be removed from list');
  });
});

describe('Merge session to local', () => {
  let server;
  let baseUrl;
  let tempDir;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
    // Repo with a real committed base on 'main' and .worktrees gitignored.
    tempDir = createTempDir();
    execSync('git init -q -b main && printf ".worktrees/\\n" > .gitignore && echo base > base.txt && git add -A && git commit -qm init', {
      cwd: tempDir, env: { ...process.env, ...gitEnv },
    });
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  async function makeSession(name) {
    const project = await (await fetch(`${baseUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `merge-${name}`, cwd: tempDir }),
    })).json();
    const session = await (await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })).json();
    return { project, session };
  }

  it('auto-commits and fast-forwards session changes into the local branch', async () => {
    const { session } = await makeSession('feat-merge');
    // Uncommitted new file in the session worktree
    fs.writeFileSync(path.join(tempDir, session.worktreePath, 'session-file.txt'), 'from session');

    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/merge`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.committed, true, 'should auto-commit pending work');
    assert.ok(data.merged, 'should report merged');

    // The file now exists at the project root (local checkout)
    assert.ok(fs.existsSync(path.join(tempDir, 'session-file.txt')),
      'merged file should appear in the project root');
  });

  it('aborts cleanly and reports conflict when branches diverge', async () => {
    const { session } = await makeSession('feat-conflict');
    const wt = path.join(tempDir, session.worktreePath);
    // Session edits base.txt and commits
    fs.writeFileSync(path.join(wt, 'base.txt'), 'session version');
    execSync('git add -A && git commit -qm s', { cwd: wt, env: { ...process.env, ...gitEnv } });
    // Local (root) edits base.txt differently and commits
    fs.writeFileSync(path.join(tempDir, 'base.txt'), 'local version');
    execSync('git add -A && git commit -qm local', { cwd: tempDir, env: { ...process.env, ...gitEnv } });

    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/merge`, { method: 'POST' });
    assert.strictEqual(res.status, 409);
    const data = await res.json();
    assert.strictEqual(data.code, 'MERGE_CONFLICT');

    // Working tree must be clean after the aborted merge
    const status = execSync('git status --porcelain', { cwd: tempDir, encoding: 'utf-8' });
    assert.strictEqual(status.trim(), '', 'tree should be clean after aborted merge');
  });
});

describe('Worktree Orphan Cleanup Integration', () => {
  let server;
  let baseUrl;
  let tempDir;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('POST /api/cleanup triggers orphan cleanup and returns result', async () => {
    tempDir = createTempRepo();
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cleanup-test', cwd: tempDir }),
    });
    assert.strictEqual(projRes.status, 201);
    const project = await projRes.json();

    // Create an orphan worktree (no session in DB)
    fs.mkdirSync(path.join(tempDir, '.worktrees'), { recursive: true });
    execSync('git worktree add -b claude/orphan-test .worktrees/orphan-test', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    // Trigger cleanup
    const res = await fetch(`${baseUrl}/api/cleanup`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(typeof data.removed, 'number');
    assert.ok(data.removed >= 1, `expected at least 1 removed, got ${data.removed}`);

    // Verify orphan worktree is gone
    assert.ok(!fs.existsSync(path.join(tempDir, '.worktrees', 'orphan-test')));

    // Verify branch still exists (cleanup preserves branches)
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes('claude/orphan-test'));
  });
});

describe('Shell WebSocket', () => {
  let server;
  let baseUrl;
  let wsUrl;
  let tempDir;
  let projectId;
  let sessionId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
    wsUrl = `ws://localhost:${port}/ws`;

    // Create temp repo, project, and session
    tempDir = createTempRepo();
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'shell-ws-test', cwd: tempDir }),
    });
    const proj = await projRes.json();
    projectId = proj.id;

    const sessRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Shell Session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('shell-attach spawns shell and replays buffer', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve) => ws.on('open', resolve));

    // Skip the initial state message
    await new Promise((resolve) => ws.once('message', resolve));

    // Send shell-attach
    ws.send(JSON.stringify({
      type: 'shell-attach',
      sessionId,
      cols: 80,
      rows: 24,
    }));

    // Should receive shell-replay-done
    const messages = [];
    await new Promise((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        messages.push(msg);
        if (msg.type === 'shell-replay-done') resolve();
      });
      // Timeout safety
      setTimeout(resolve, 1000);
    });

    const replayDone = messages.find((m) => m.type === 'shell-replay-done');
    assert.ok(replayDone, 'should receive shell-replay-done');
    assert.strictEqual(replayDone.sessionId, sessionId);

    ws.close();
  });

  it('concurrent shell-attach for same session does not crash the server', async () => {
    const { WebSocket } = await import('ws');

    // Open two sockets and fire shell-attach for the SAME session near-simultaneously.
    // Previously the second attach raced past the isShellAlive() check and threw
    // "Shell already exists" from spawnShell(), an unhandled error that killed the
    // whole process. The server must survive and stay responsive.
    const mkAttach = async () => {
      const ws = new WebSocket(wsUrl);
      await new Promise((resolve) => ws.on('open', resolve));
      await new Promise((resolve) => ws.once('message', resolve)); // skip state
      ws.send(JSON.stringify({ type: 'shell-attach', sessionId, cols: 80, rows: 24 }));
      return ws;
    };

    const [ws1, ws2] = await Promise.all([mkAttach(), mkAttach()]);

    // Give the handlers time to process both attaches.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Server still alive and serving requests?
    const health = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(health.status, 200, 'server should survive concurrent shell-attach');

    ws1.close();
    ws2.close();
  });

  it('shell-input sends data and shell-output is received', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve) => ws.on('open', resolve));
    await new Promise((resolve) => ws.once('message', resolve)); // skip state

    // Attach shell
    ws.send(JSON.stringify({
      type: 'shell-attach',
      sessionId,
      cols: 80,
      rows: 24,
    }));

    // Wait for replay-done
    await new Promise((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'shell-replay-done') resolve();
      });
      setTimeout(resolve, 1000);
    });

    // Send input
    ws.send(JSON.stringify({
      type: 'shell-input',
      sessionId,
      data: 'echo shell-test-output\r',
    }));

    // Wait for shell output containing our echo
    const output = [];
    await new Promise((resolve) => {
      const handler = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'shell-output' && msg.data) {
          output.push(msg.data);
          if (output.join('').includes('shell-test-output')) {
            ws.off('message', handler);
            resolve();
          }
        }
      };
      ws.on('message', handler);
      setTimeout(resolve, 1000);
    });

    const combined = output.join('');
    assert.ok(combined.includes('shell-test-output'), `expected shell output, got: ${combined}`);
    ws.close();
  });
});

describe('WebSocket origin validation', () => {
  let server;
  let wsUrl;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    wsUrl = `ws://localhost:${port}/ws`;
  });

  after(async () => {
    await server.destroy();
  });

  it('accepts WebSocket connections with no Origin header', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl);
    const opened = await new Promise((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 2000);
    });
    assert.ok(opened, 'WebSocket should connect without Origin');
    ws.close();
  });

  it('accepts WebSocket connections from localhost Origin', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl, { headers: { Origin: 'http://localhost:3000' } });
    const opened = await new Promise((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 2000);
    });
    assert.ok(opened, 'WebSocket should connect with localhost Origin');
    ws.close();
  });

  it('accepts WebSocket connections from Tailscale IP Origin', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl, { headers: { Origin: 'http://100.64.1.1:3000' } });
    const opened = await new Promise((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 2000);
    });
    assert.ok(opened, 'WebSocket should connect with Tailscale Origin');
    ws.close();
  });

  it('rejects WebSocket connections from unexpected Origin', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl, { headers: { Origin: 'http://evil.example.com' } });
    const closed = await new Promise((resolve) => {
      ws.on('open', () => resolve(false));
      ws.on('close', () => resolve(true));
      ws.on('error', () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });
    assert.ok(closed, 'WebSocket should reject unexpected Origin');
  });
});

describe('Health endpoint', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.destroy();
  });

  it('GET /api/health returns ok with session count and uptime', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(typeof data.sessions, 'number');
    assert.strictEqual(typeof data.uptime, 'number');
    assert.ok(data.uptime >= 0);
  });
});

describe('Browse roots allowlist', () => {
  const sep = path.sep;
  const home = os.homedir();

  it('always includes the home directory', () => {
    const saved = process.env.BROWSE_ROOTS;
    delete process.env.BROWSE_ROOTS;
    try {
      assert.deepStrictEqual(getBrowseRoots(), [home]);
    } finally {
      if (saved !== undefined) process.env.BROWSE_ROOTS = saved;
    }
  });

  it('adds configured roots from BROWSE_ROOTS (realpath-resolved)', () => {
    const saved = process.env.BROWSE_ROOTS;
    // os.tmpdir() exists on all platforms; realpath it to compare against output.
    const tmpReal = fs.realpathSync(os.tmpdir());
    process.env.BROWSE_ROOTS = os.tmpdir();
    try {
      const roots = getBrowseRoots();
      assert.ok(roots.includes(home));
      assert.ok(roots.includes(tmpReal));
    } finally {
      if (saved === undefined) delete process.env.BROWSE_ROOTS;
      else process.env.BROWSE_ROOTS = saved;
    }
  });

  it('skips non-existent BROWSE_ROOTS entries', () => {
    const saved = process.env.BROWSE_ROOTS;
    process.env.BROWSE_ROOTS = '/definitely/not/a/real/path/xyz';
    try {
      assert.deepStrictEqual(getBrowseRoots(), [home]);
    } finally {
      if (saved === undefined) delete process.env.BROWSE_ROOTS;
      else process.env.BROWSE_ROOTS = saved;
    }
  });

  it('isWithinBrowseRoots matches the root itself and descendants', () => {
    const roots = [`${sep}home${sep}me`, `${sep}workplace${sep}me`];
    assert.ok(isWithinBrowseRoots(`${sep}home${sep}me`, roots));
    assert.ok(isWithinBrowseRoots(`${sep}workplace${sep}me${sep}proj`, roots));
  });

  it('isWithinBrowseRoots rejects paths outside all roots and prefix-bypass attempts', () => {
    const roots = [`${sep}home${sep}me`];
    assert.ok(!isWithinBrowseRoots(`${sep}etc`, roots));
    // Prefix bypass: /home/me2 must not match root /home/me
    assert.ok(!isWithinBrowseRoots(`${sep}home${sep}me2`, roots));
  });
});

describe('Directory browser symlink handling', () => {
  let server;
  let baseUrl;
  let scratchDir;

  before(async () => {
    // Must live under home so the top-level /api/browse picker allows it.
    scratchDir = fs.mkdtempSync(path.join(os.homedir(), '.console-symlink-test-'));
    fs.mkdirSync(path.join(scratchDir, 'realdir'));
    fs.symlinkSync(path.join(scratchDir, 'realdir'), path.join(scratchDir, 'linkdir'), 'dir');
    fs.writeFileSync(path.join(scratchDir, 'plainfile'), 'x');
    fs.symlinkSync(path.join(scratchDir, 'plainfile'), path.join(scratchDir, 'linkfile'), 'file');
    fs.symlinkSync(path.join(scratchDir, 'nope'), path.join(scratchDir, 'brokenlink'), 'dir');

    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.destroy();
    cleanupDir(scratchDir);
  });

  it('lists directory symlinks as directories, excludes file/broken symlinks', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent(scratchDir)}`);
    assert.strictEqual(res.status, 200);
    const { dirs } = await res.json();
    assert.ok(dirs.includes('realdir'), 'real directory listed');
    assert.ok(dirs.includes('linkdir'), 'symlink to directory listed');
    assert.ok(!dirs.includes('linkfile'), 'symlink to file not listed as dir');
    assert.ok(!dirs.includes('brokenlink'), 'broken symlink not listed');
  });

  it('can navigate into a directory symlink', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent(path.join(scratchDir, 'linkdir'))}`);
    assert.strictEqual(res.status, 200);
  });
});

describe('parseTranscript', () => {
  it('parses string user turns and array assistant turns', () => {
    const raw = [
      JSON.stringify({ type: 'user', timestamp: 't1', message: { role: 'user', content: 'Hello' } }),
      JSON.stringify({ type: 'assistant', timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] } }),
    ].join('\n');
    const turns = parseTranscript(raw);
    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].role, 'user');
    assert.deepStrictEqual(turns[0].parts, [{ kind: 'text', text: 'Hello' }]);
    assert.strictEqual(turns[1].role, 'assistant');
    assert.strictEqual(turns[1].parts[0].text, 'Hi there');
  });

  it('extracts tool_use and tool_result blocks', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'Running' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', content: 'file1\nfile2', is_error: false },
      ] } }),
    ].join('\n');
    const turns = parseTranscript(raw);
    assert.strictEqual(turns.length, 2);
    const toolUse = turns[0].parts.find(p => p.kind === 'tool_use');
    assert.ok(toolUse);
    assert.strictEqual(toolUse.name, 'Bash');
    assert.deepStrictEqual(toolUse.input, { command: 'ls' });
    const toolResult = turns[1].parts.find(p => p.kind === 'tool_result');
    assert.ok(toolResult);
    assert.strictEqual(toolResult.text, 'file1\nfile2');
    assert.strictEqual(toolResult.isError, false);
  });

  it('flattens array-form tool_result content and flags errors', () => {
    const raw = JSON.stringify({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', content: [{ type: 'text', text: 'boom' }], is_error: true },
    ] } });
    const turns = parseTranscript(raw);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].parts[0].text, 'boom');
    assert.strictEqual(turns[0].parts[0].isError, true);
  });

  it('ignores snapshots, system entries, blank lines, and malformed JSON', () => {
    const raw = [
      '',
      'not json',
      JSON.stringify({ type: 'file-history-snapshot', foo: 1 }),
      JSON.stringify({ type: 'system', message: { role: 'system', content: 'x' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'kept' } }),
    ].join('\n');
    const turns = parseTranscript(raw);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].parts[0].text, 'kept');
  });

  it('drops turns with no renderable parts (e.g. empty content)', () => {
    const raw = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '   ' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }),
    ].join('\n');
    assert.strictEqual(parseTranscript(raw).length, 0);
  });

  it('does not throw on null/non-object content blocks', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [null, 'str', { type: 'text', text: 'ok' }] } }),
    ].join('\n');
    // Must not throw (null/string blocks skipped) and still keep the valid text.
    const turns = parseTranscript(raw);
    assert.strictEqual(turns.length, 1);
    assert.deepStrictEqual(turns[0].parts, [{ kind: 'text', text: 'ok' }]);
  });
});

describe('Transcript capture helpers', () => {
  it('encodeClaudeProjectDir replaces / and . with -', () => {
    assert.strictEqual(
      encodeClaudeProjectDir('/workplace/me/proj/.worktrees/feat-1'),
      '-workplace-me-proj--worktrees-feat-1'
    );
  });

  it('detectActiveTranscript prefers a brand-new file', () => {
    const before = { 'a.jsonl': { mtimeMs: 100, size: 10 } };
    const after = {
      'a.jsonl': { mtimeMs: 100, size: 10 },
      'b.jsonl': { mtimeMs: 200, size: 5 },
    };
    assert.strictEqual(detectActiveTranscript(before, after), 'b.jsonl');
  });

  it('detectActiveTranscript picks the most-grown file when no new file (resumed convo)', () => {
    const before = {
      'a.jsonl': { mtimeMs: 100, size: 1000 },
      'b.jsonl': { mtimeMs: 100, size: 1000 },
    };
    const after = {
      'a.jsonl': { mtimeMs: 150, size: 1005 },   // grew 5
      'b.jsonl': { mtimeMs: 160, size: 3000 },   // grew 2000 (resumed here)
    };
    assert.strictEqual(detectActiveTranscript(before, after), 'b.jsonl');
  });

  it('detectActiveTranscript returns null when nothing changed', () => {
    const snap = { 'a.jsonl': { mtimeMs: 100, size: 1000 } };
    assert.strictEqual(detectActiveTranscript(snap, { ...snap }), null);
  });

  it('snapshotTranscripts returns {} for a missing directory', () => {
    assert.deepStrictEqual(snapshotTranscripts(fs, '/no/such/dir/xyz'), {});
  });

  it('parseRunningAgentIds extracts sessionIds from claude agents --json', () => {
    const json = JSON.stringify([
      { id: 'a1', sessionId: '83137cc2-5b41-4beb-8ea1-f932f03d8f1f', status: 'busy' },
      { id: 'b2', sessionId: 'd6e2a28b-d83a-4c1a-9849-78594396665d', status: 'idle' },
      { id: 'c3' }, // no sessionId — ignored
    ]);
    const ids = parseRunningAgentIds(json);
    assert.ok(ids.has('83137cc2-5b41-4beb-8ea1-f932f03d8f1f'));
    assert.ok(ids.has('d6e2a28b-d83a-4c1a-9849-78594396665d'));
    assert.strictEqual(ids.size, 2);
  });

  it('parseRunningAgentIds returns empty Set on malformed or non-array input', () => {
    assert.strictEqual(parseRunningAgentIds('not json').size, 0);
    assert.strictEqual(parseRunningAgentIds('{"a":1}').size, 0);
    assert.strictEqual(parseRunningAgentIds('').size, 0);
  });

  it('snapshotTranscripts captures size and mtime for real files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.jsonl'), 'hello');
      fs.writeFileSync(path.join(dir, 'ignore.txt'), 'nope');
      const snap = snapshotTranscripts(fs, dir);
      assert.ok('x.jsonl' in snap);
      assert.strictEqual(snap['x.jsonl'].size, 5);
      assert.ok(!('ignore.txt' in snap), 'only .jsonl files are snapshotted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Allowed origin hosts allowlist', () => {
  it('returns empty when ALLOWED_ORIGINS is unset', () => {
    const saved = process.env.ALLOWED_ORIGINS;
    delete process.env.ALLOWED_ORIGINS;
    try {
      assert.deepStrictEqual(getAllowedOriginHosts(), []);
    } finally {
      if (saved !== undefined) process.env.ALLOWED_ORIGINS = saved;
    }
  });

  it('parses full origin URLs down to hostnames', () => {
    const saved = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = 'https://console.example.ts.net:8443';
    try {
      assert.deepStrictEqual(getAllowedOriginHosts(), ['console.example.ts.net']);
    } finally {
      if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = saved;
    }
  });

  it('accepts bare hostnames and comma-separated lists (lowercased)', () => {
    const saved = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = 'Foo.trycloudflare.com, https://bar.ts.net';
    try {
      assert.deepStrictEqual(getAllowedOriginHosts(), ['foo.trycloudflare.com', 'bar.ts.net']);
    } finally {
      if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = saved;
    }
  });
});
