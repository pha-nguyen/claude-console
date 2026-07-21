// test/store.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStore } from '../store.js';

describe('Store: database setup', () => {
  it('createStore returns an object with expected methods', () => {
    const store = createStore(':memory:');
    assert.strictEqual(typeof store.getProjects, 'function');
    assert.strictEqual(typeof store.getProject, 'function');
    assert.strictEqual(typeof store.createProject, 'function');
    assert.strictEqual(typeof store.deleteProject, 'function');
    assert.strictEqual(typeof store.getSessions, 'function');
    assert.strictEqual(typeof store.getSession, 'function');
    assert.strictEqual(typeof store.createSession, 'function');
    assert.strictEqual(typeof store.updateSession, 'function');
    assert.strictEqual(typeof store.deleteSession, 'function');
    assert.strictEqual(typeof store.getAll, 'function');
    assert.strictEqual(typeof store.close, 'function');
  });

  it('getProjects returns empty array on fresh db', () => {
    const store = createStore(':memory:');
    assert.deepStrictEqual(store.getProjects(), []);
  });

  it('getAll returns empty projects and sessions on fresh db', () => {
    const store = createStore(':memory:');
    assert.deepStrictEqual(store.getAll(), { projects: [], sessions: [] });
  });
});

describe('Store: project CRUD', () => {
  it('createProject and getProject', () => {
    const store = createStore(':memory:');
    const project = store.createProject({
      id: 'p1',
      name: 'test-proj',
      cwd: '/tmp/test',
      createdAt: '2026-02-06T00:00:00.000Z',
    });
    assert.strictEqual(project.id, 'p1');
    assert.strictEqual(project.name, 'test-proj');
    assert.strictEqual(project.cwd, '/tmp/test');
    assert.strictEqual(project.createdAt, '2026-02-06T00:00:00.000Z');

    const fetched = store.getProject('p1');
    assert.deepStrictEqual(fetched, project);
  });

  it('getProject returns undefined for missing id', () => {
    const store = createStore(':memory:');
    assert.strictEqual(store.getProject('nonexistent'), undefined);
  });

  it('getProjects returns all projects ordered by createdAt', () => {
    const store = createStore(':memory:');
    store.createProject({ id: 'p2', name: 'second', cwd: '/b', createdAt: '2026-02-06T01:00:00.000Z' });
    store.createProject({ id: 'p1', name: 'first', cwd: '/a', createdAt: '2026-02-06T00:00:00.000Z' });
    const projects = store.getProjects();
    assert.strictEqual(projects.length, 2);
    assert.strictEqual(projects[0].id, 'p1');
    assert.strictEqual(projects[1].id, 'p2');
  });

  it('deleteProject removes project and its sessions', () => {
    const store = createStore(':memory:');
    store.createProject({ id: 'p1', name: 'proj', cwd: '/tmp', createdAt: '2026-02-06T00:00:00.000Z' });
    store.createSession({
      id: 's1', projectId: 'p1', name: 'sess', branchName: 'b1',
      worktreePath: '.worktrees/b1', claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    store.deleteProject('p1');
    assert.strictEqual(store.getProject('p1'), undefined);
    assert.strictEqual(store.getSession('s1'), undefined);
  });

  it('createProject throws on duplicate id', () => {
    const store = createStore(':memory:');
    store.createProject({ id: 'p1', name: 'a', cwd: '/a', createdAt: '2026-02-06T00:00:00.000Z' });
    assert.throws(() => {
      store.createProject({ id: 'p1', name: 'b', cwd: '/b', createdAt: '2026-02-06T00:00:00.000Z' });
    });
  });
});

describe('Store: session CRUD', () => {
  function storeWithProject() {
    const store = createStore(':memory:');
    store.createProject({ id: 'p1', name: 'proj', cwd: '/tmp', createdAt: '2026-02-06T00:00:00.000Z' });
    return store;
  }

  it('createSession and getSession', () => {
    const store = storeWithProject();
    const session = store.createSession({
      id: 's1', projectId: 'p1', name: 'my-session',
      branchName: 'my-session-abc1234', worktreePath: '.worktrees/my-session-abc1234',
      claudeSessionId: null, status: 'running',
      createdAt: '2026-02-06T00:00:00.000Z',
    });
    assert.strictEqual(session.id, 's1');
    assert.strictEqual(session.projectId, 'p1');
    assert.strictEqual(session.name, 'my-session');
    assert.strictEqual(session.branchName, 'my-session-abc1234');
    assert.strictEqual(session.worktreePath, '.worktrees/my-session-abc1234');
    assert.strictEqual(session.claudeSessionId, null);
    assert.strictEqual(session.status, 'running');

    const fetched = store.getSession('s1');
    assert.deepStrictEqual(fetched, session);
  });

  it('getSession returns undefined for missing id', () => {
    const store = storeWithProject();
    assert.strictEqual(store.getSession('nonexistent'), undefined);
  });

  it('getSessions returns sessions for a project ordered by createdAt', () => {
    const store = storeWithProject();
    store.createSession({
      id: 's2', projectId: 'p1', name: 'second', branchName: 'b2',
      worktreePath: '.worktrees/b2', claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T01:00:00.000Z',
    });
    store.createSession({
      id: 's1', projectId: 'p1', name: 'first', branchName: 'b1',
      worktreePath: '.worktrees/b1', claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    const sessions = store.getSessions('p1');
    assert.strictEqual(sessions.length, 2);
    assert.strictEqual(sessions[0].id, 's1');
    assert.strictEqual(sessions[1].id, 's2');
  });

  it('updateSession updates status', () => {
    const store = storeWithProject();
    store.createSession({
      id: 's1', projectId: 'p1', name: 'sess', branchName: null,
      worktreePath: null, claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    const updated = store.updateSession('s1', { status: 'exited' });
    assert.strictEqual(updated.status, 'exited');
    assert.strictEqual(store.getSession('s1').status, 'exited');
  });

  it('updateSession updates claudeSessionId', () => {
    const store = storeWithProject();
    store.createSession({
      id: 's1', projectId: 'p1', name: 'sess', branchName: null,
      worktreePath: null, claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    const updated = store.updateSession('s1', { claudeSessionId: 'uuid-abc-123' });
    assert.strictEqual(updated.claudeSessionId, 'uuid-abc-123');
    assert.strictEqual(updated.status, 'running');
  });

  it('updateSession returns undefined for missing id', () => {
    const store = storeWithProject();
    assert.strictEqual(store.updateSession('nonexistent', { status: 'exited' }), undefined);
  });

  it('updateSession persists name, branchName, and worktreePath (no silent drop)', () => {
    const store = storeWithProject();
    store.createSession({
      id: 's1', projectId: 'p1', name: 'old', branchName: 'b-old',
      worktreePath: '.worktrees/b-old', claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    const updated = store.updateSession('s1', {
      name: 'new', branchName: 'b-new', worktreePath: '.worktrees/b-new',
    });
    assert.strictEqual(updated.name, 'new');
    assert.strictEqual(updated.branchName, 'b-new');
    assert.strictEqual(updated.worktreePath, '.worktrees/b-new');
    // Untouched fields preserved
    assert.strictEqual(updated.status, 'running');
    const reread = store.getSession('s1');
    assert.strictEqual(reread.name, 'new');
    assert.strictEqual(reread.worktreePath, '.worktrees/b-new');
  });

  it('updateSession preserves omitted fields but clears on explicit null', () => {
    const store = storeWithProject();
    store.createSession({
      id: 's1', projectId: 'p1', name: 'sess', branchName: 'b1',
      worktreePath: '.worktrees/b1', claudeSessionId: 'cid-1',
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    // Omitted fields keep their values; only status changes.
    let u = store.updateSession('s1', { status: 'exited' });
    assert.strictEqual(u.branchName, 'b1');
    assert.strictEqual(u.claudeSessionId, 'cid-1');
    // Explicit null clears.
    u = store.updateSession('s1', { claudeSessionId: null });
    assert.strictEqual(u.claudeSessionId, null);
    assert.strictEqual(u.branchName, 'b1');
  });

  it('deleteSession removes session', () => {
    const store = storeWithProject();
    store.createSession({
      id: 's1', projectId: 'p1', name: 'sess', branchName: null,
      worktreePath: null, claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    store.deleteSession('s1');
    assert.strictEqual(store.getSession('s1'), undefined);
  });

  it('getAll returns all projects and sessions', () => {
    const store = storeWithProject();
    store.createSession({
      id: 's1', projectId: 'p1', name: 'sess', branchName: 'b1',
      worktreePath: '.worktrees/b1', claudeSessionId: null,
      status: 'running', createdAt: '2026-02-06T00:00:00.000Z',
    });
    const all = store.getAll();
    assert.strictEqual(all.projects.length, 1);
    assert.strictEqual(all.sessions.length, 1);
    assert.strictEqual(all.projects[0].id, 'p1');
    assert.strictEqual(all.sessions[0].id, 's1');
  });

  it('createSession with nullable fields', () => {
    const store = storeWithProject();
    const session = store.createSession({
      id: 's1', projectId: 'p1', name: 'no-worktree',
      createdAt: '2026-02-06T00:00:00.000Z',
    });
    assert.strictEqual(session.branchName, null);
    assert.strictEqual(session.worktreePath, null);
    assert.strictEqual(session.claudeSessionId, null);
    assert.strictEqual(session.status, 'running');
  });
});

describe('store.getSessionWorktreePaths', () => {
  it('returns worktree paths for sessions with worktreePath set', () => {
    const store = createStore(':memory:');

    store.createProject({
      id: 'p1',
      name: 'test-project',
      cwd: '/tmp/repo',
      createdAt: new Date().toISOString(),
    });

    store.createSession({
      id: 's1',
      projectId: 'p1',
      name: 'session-1',
      branchName: 'fix-bug-abc1234',
      worktreePath: '.worktrees/fix-bug-abc1234',
      claudeSessionId: null,
      status: 'running',
      createdAt: new Date().toISOString(),
    });

    store.createSession({
      id: 's2',
      projectId: 'p1',
      name: 'session-2',
      branchName: null,
      worktreePath: null,
      claudeSessionId: null,
      status: 'running',
      createdAt: new Date().toISOString(),
    });

    const paths = store.getSessionWorktreePaths('p1');
    assert.deepStrictEqual(paths, ['.worktrees/fix-bug-abc1234']);

    store.close();
  });

  it('returns empty array when no sessions have worktree paths', () => {
    const store = createStore(':memory:');

    store.createProject({
      id: 'p1',
      name: 'test-project',
      cwd: '/tmp/repo',
      createdAt: new Date().toISOString(),
    });

    const paths = store.getSessionWorktreePaths('p1');
    assert.deepStrictEqual(paths, []);

    store.close();
  });
});
