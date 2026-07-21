// store.js — SQLite-backed store via better-sqlite3
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.claude-console');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'data.db');

function rowToProject(row) {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    createdAt: row.created_at,
  };
}

function rowToSession(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    claudeSessionId: row.claude_session_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function createStore(dbPath) {
  if (!dbPath) {
    dbPath = DEFAULT_DB_PATH;
  }

  // Ensure directory exists for non-memory databases
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      branch_name TEXT,
      worktree_path TEXT,
      claude_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
  `);

  // --- Schema migrations ---
  // The base tables above establish the v1 schema for fresh databases. Existing
  // databases created before a column was added won't get it from CREATE TABLE
  // IF NOT EXISTS, so evolve them here, keyed on PRAGMA user_version. To add a
  // future migration: append a step that runs when version < N and bump to N.
  const migrations = [
    // Example (leave commented until needed):
    // { version: 2, up: (d) => d.exec('ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0') },
  ];
  const runMigrations = db.transaction(() => {
    let version = db.pragma('user_version', { simple: true });
    for (const m of migrations) {
      if (version < m.version) {
        m.up(db);
        version = m.version;
      }
    }
    // Baseline: a fresh DB (or one predating versioning) is at least v1.
    if (version < 1) version = 1;
    db.pragma(`user_version = ${version}`);
  });
  runMigrations();

  // Prepared statements
  const stmts = {
    getProjects: db.prepare('SELECT * FROM projects ORDER BY created_at ASC'),
    getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
    insertProject: db.prepare('INSERT INTO projects (id, name, cwd, created_at) VALUES (@id, @name, @cwd, @createdAt)'),
    deleteProjectSessions: db.prepare('DELETE FROM sessions WHERE project_id = ?'),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
    getSessions: db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at ASC'),
    getAllSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at ASC'),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    insertSession: db.prepare(
      'INSERT INTO sessions (id, project_id, name, branch_name, worktree_path, claude_session_id, status, created_at) VALUES (@id, @projectId, @name, @branchName, @worktreePath, @claudeSessionId, @status, @createdAt)'
    ),
    updateSession: db.prepare(
      'UPDATE sessions SET name = @name, branch_name = @branchName, worktree_path = @worktreePath, claude_session_id = @claudeSessionId, status = @status WHERE id = @id'
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    getSessionWorktreePaths: db.prepare(
      'SELECT worktree_path FROM sessions WHERE project_id = ? AND worktree_path IS NOT NULL'
    ),
  };

  return {
    getProjects() {
      return stmts.getProjects.all().map(rowToProject);
    },

    getProject(id) {
      const row = stmts.getProject.get(id);
      return row ? rowToProject(row) : undefined;
    },

    createProject({ id, name, cwd, createdAt }) {
      stmts.insertProject.run({ id, name, cwd, createdAt });
      return this.getProject(id);
    },

    deleteProject: db.transaction(function (id) {
      stmts.deleteProjectSessions.run(id);
      stmts.deleteProject.run(id);
    }),

    getSessions(projectId) {
      return stmts.getSessions.all(projectId).map(rowToSession);
    },

    getSession(id) {
      const row = stmts.getSession.get(id);
      return row ? rowToSession(row) : undefined;
    },

    createSession({ id, projectId, name, branchName, worktreePath, claudeSessionId, status, createdAt }) {
      stmts.insertSession.run({
        id,
        projectId,
        name,
        branchName: branchName ?? null,
        worktreePath: worktreePath ?? null,
        claudeSessionId: claudeSessionId ?? null,
        status: status ?? 'running',
        createdAt,
      });
      return this.getSession(id);
    },

    updateSession(id, fields) {
      const current = this.getSession(id);
      if (!current) return undefined;
      // Persist every updatable column. Use `in fields` (not ??) so an explicit
      // null clears a value, while an omitted field keeps the current one.
      // Previously only status/claudeSessionId were written and any other field
      // (name, branchName, worktreePath) passed by a caller was silently dropped.
      const pick = (key) => (key in fields ? fields[key] : current[key]);
      stmts.updateSession.run({
        id,
        name: pick('name'),
        branchName: pick('branchName'),
        worktreePath: pick('worktreePath'),
        claudeSessionId: pick('claudeSessionId'),
        status: pick('status'),
      });
      return this.getSession(id);
    },

    deleteSession(id) {
      stmts.deleteSession.run(id);
    },

    getSessionWorktreePaths(projectId) {
      return stmts.getSessionWorktreePaths.all(projectId).map(row => row.worktree_path);
    },

    getAll() {
      return {
        projects: this.getProjects(),
        sessions: stmts.getAllSessions.all().map(rowToSession),
      };
    },

    close() {
      db.close();
    },
  };
}
