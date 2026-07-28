// server.js
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PtyManager } from './pty-manager.js';
import { createStore } from './store.js';
import {
  validateGitRepo,
  validateWorktreesDir,
  resolveWorktreePath,
  sanitizeBranchName,
  createWorktree,
  removeWorktree,
  worktreeExists,
  isWorktreeDirty,
  isWorktreesIgnored,
  WorktreeDirtyCheckError,
  cleanupOrphanedWorktrees,
  mergeSessionToMain,
} from './git-worktree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_NAME_LENGTH = 100;
const MAX_CWD_LENGTH = 1024;

// Worktrees are OFF by default: sessions run directly in the project root
// (Claude and the shell), with a single file scope, and are stored with
// branchName/worktreePath = null (every worktree-aware path already treats a
// null worktreePath as "use the project cwd"). Set WORKTREES to on/1/true/yes
// to opt into isolated per-session git worktrees. Exported for testing.
export function worktreesEnabledFromEnv(env = process.env) {
  return /^(on|1|true|yes)$/i.test(env.WORKTREES || '');
}

/**
 * Parse extra allowed WebSocket/API origins from the ALLOWED_ORIGINS env var
 * (comma-separated). Used to permit access through a tunnel or reverse proxy
 * whose hostname isn't localhost or a Tailscale 100.x address — e.g.
 * `ALLOWED_ORIGINS=https://console.example.ts.net,https://foo.trycloudflare.com`.
 * Each entry is matched by hostname, so the scheme/port in the value is optional.
 */
export function getAllowedOriginHosts() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return [];
  const hosts = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Accept either a bare hostname or a full origin URL.
    let host = trimmed;
    try {
      host = new URL(trimmed).hostname;
    } catch {
      try {
        host = new URL(`https://${trimmed}`).hostname;
      } catch {
        console.warn(`[origin] Skipping invalid ALLOWED_ORIGINS entry: ${trimmed}`);
        continue;
      }
    }
    hosts.push(host.toLowerCase());
  }
  return hosts;
}

const ALLOWED_ORIGIN_HOSTS = getAllowedOriginHosts();

/**
 * Compute the set of directory roots the directory browser (`/api/browse`)
 * is allowed to serve. Always includes the home directory. Additional roots
 * can be added via the BROWSE_ROOTS env var (path.delimiter-separated, e.g.
 * `BROWSE_ROOTS=/workplace/me:/data`). Each root is resolved through realpath
 * so a root that is itself a symlink still matches after realpath resolution
 * of requested paths. A leading `~` is expanded to the home directory.
 */
export function getBrowseRoots() {
  const homedir = os.homedir();
  const roots = new Set([homedir]);
  const raw = process.env.BROWSE_ROOTS;
  if (raw) {
    for (const entry of raw.split(path.delimiter)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const expanded = trimmed.startsWith('~')
        ? trimmed.replace(/^~/, homedir)
        : trimmed;
      let resolved;
      try {
        resolved = fs.realpathSync(path.resolve(expanded));
      } catch {
        console.warn(`[browse] Skipping BROWSE_ROOTS entry (not found): ${trimmed}`);
        continue;
      }
      roots.add(resolved);
    }
  }
  return [...roots];
}

/** True if `resolved` (an already-realpath'd absolute path) is within any allowed root. */
export function isWithinBrowseRoots(resolved, roots) {
  return roots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
}

/**
 * Resolve the root a scope-aware endpoint (/api/browse, /api/file) should serve:
 * the project root when scope='project' or the session has no worktree,
 * otherwise the session's worktree. Throws an error with .code
 * INVALID_WORKTREE_PATH (mapped to 400 by callers) on a bad worktree path.
 */
async function resolveScopedRoot(session, project, scope) {
  if (scope === 'project' || !session.worktreePath) {
    return project.cwd;
  }
  return resolveWorktreePath(project.cwd, session.worktreePath);
}

/**
 * Parse `claude agents --json` output into a Set of sessionIds that are
 * currently running (any live agent — background or interactive). Used to
 * detect a resume that would collide with an already-running conversation.
 * Tolerant of malformed input (returns an empty Set).
 */
export function parseRunningAgentIds(stdout) {
  const ids = new Set();
  let arr;
  try { arr = JSON.parse(stdout); } catch { return ids; }
  if (!Array.isArray(arr)) return ids;
  for (const a of arr) {
    if (a && typeof a.sessionId === 'string') ids.add(a.sessionId);
  }
  return ids;
}

/**
 * Encode a filesystem path into the Claude CLI project-dir name (replace '/'
 * and '.' with '-'). The caller passes an already-realpath'd absolute path.
 */
export function encodeClaudeProjectDir(realCwd) {
  return realCwd.replace(/\//g, '-').replace(/\./g, '-');
}

/**
 * Snapshot the .jsonl transcripts in a Claude project dir as a map of
 * filename -> { mtimeMs, size }. Used to detect both brand-NEW conversation
 * files and APPENDED-to existing ones (a resumed conversation appends to its
 * existing transcript rather than creating a new file). Missing dir -> {}.
 */
export function snapshotTranscripts(fsMod, dir) {
  const out = {};
  let names;
  try {
    names = fsMod.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const st = fsMod.statSync(path.join(dir, name));
      out[name] = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      /* file vanished between readdir and stat — skip */
    }
  }
  return out;
}

/**
 * Given a before-snapshot and the current dir state, return the filename of the
 * transcript that was newly created or grown the most since `before` — i.e. the
 * one this session is writing to. Returns null if nothing changed. Prefers a
 * brand-new file; otherwise the existing file with the largest size increase
 * (a resumed conversation appends to its own transcript).
 */
export function detectActiveTranscript(before, after) {
  // 1. Brand-new files first (most recently modified wins).
  const newNames = Object.keys(after).filter((n) => !(n in before));
  if (newNames.length > 0) {
    newNames.sort((a, b) => after[b].mtimeMs - after[a].mtimeMs);
    return newNames[0];
  }
  // 2. Otherwise the existing file that grew the most (appended = resumed).
  let best = null;
  let bestGrowth = 0;
  for (const name of Object.keys(after)) {
    const prev = before[name];
    if (!prev) continue;
    const growth = after[name].size - prev.size;
    if (growth > bestGrowth) {
      bestGrowth = growth;
      best = name;
    }
  }
  return best;
}

/**
 * Extract renderable turns from a Claude CLI .jsonl transcript. Keeps only
 * user/assistant turns and flattens their content into text/thinking/tool
 * markers. Ignores non-message entries (snapshots, system, etc.) and malformed
 * lines. Exported for testing.
 */
export function parseTranscript(raw) {
  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg || !msg.content) continue;

    const parts = [];
    if (typeof msg.content === 'string') {
      if (msg.content.trim()) parts.push({ kind: 'text', text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && block.text) {
          parts.push({ kind: 'text', text: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          parts.push({ kind: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use') {
          parts.push({ kind: 'tool_use', name: block.name || 'tool', input: block.input });
        } else if (block.type === 'tool_result') {
          let text = '';
          if (typeof block.content === 'string') text = block.content;
          else if (Array.isArray(block.content)) {
            text = block.content.map((c) => (c && c.type === 'text' ? c.text : '')).join('');
          }
          parts.push({ kind: 'tool_result', text, isError: !!block.is_error });
        }
      }
    }
    if (parts.length === 0) continue;
    turns.push({ role: msg.role || entry.type, ts: entry.timestamp || null, parts });
  }
  return turns;
}

/**
 * Given the dirents of `parentDir`, return the names that are directories,
 * following symlinks. `readdir(..., {withFileTypes:true})` reports a symlink
 * as a symlink (isDirectory() === false) even when it points at a directory,
 * so a symlinked dir like ~/workplace would otherwise be filtered out. For
 * symlink entries we stat the target (which follows the link) and keep it if
 * it resolves to a directory; broken/unreadable links are skipped.
 */
async function listDirNames(parentDir, entries) {
  const names = [];
  await Promise.all(
    entries.map(async (e) => {
      if (e.name.startsWith('.')) return;
      if (e.isDirectory()) {
        names.push(e.name);
      } else if (e.isSymbolicLink()) {
        try {
          const s = await fs.promises.stat(path.join(parentDir, e.name));
          if (s.isDirectory()) names.push(e.name);
        } catch {
          /* broken or unreadable symlink — skip */
        }
      }
    })
  );
  return names;
}

const BROWSE_ROOTS = getBrowseRoots();

/**
 * Validate that Claude Code PreToolUse hooks are configured.
 * Since we spawn with --dangerously-skip-permissions, hooks are the safety net.
 * In strict mode (remote HOST), throws on missing hooks (fail-closed).
 * In default mode (localhost), logs warnings only (fail-open).
 */
function validateHooksConfig({ strict = false } = {}) {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  function fail(msg) {
    if (strict) throw new Error(msg);
    console.warn('WARNING: ' + msg);
  }

  try {
    fs.accessSync(settingsPath, fs.constants.R_OK);
  } catch {
    fail('~/.claude/settings.json not found. PreToolUse hooks are not configured.');
    if (!strict) console.warn('  Sessions run with --dangerously-skip-permissions and NO safety guardrails.');
    return;
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch (e) {
    fail(`Failed to parse ~/.claude/settings.json: ${e.message}`);
    return;
  }

  const preToolUse = settings?.hooks?.PreToolUse;
  if (!Array.isArray(preToolUse) || preToolUse.length === 0) {
    fail('No PreToolUse hooks configured in ~/.claude/settings.json.');
    if (!strict) console.warn('  Sessions run with --dangerously-skip-permissions and NO safety guardrails.');
    return;
  }

  const bashHook = preToolUse.find((h) => h.matcher === 'Bash');
  if (!bashHook) {
    fail('No PreToolUse hook with matcher "Bash" found.');
    if (!strict) console.warn('  Bash commands will not be validated before execution.');
    return;
  }

  // Check that the hook script(s) exist and are executable
  for (const hook of bashHook.hooks || []) {
    if (hook.type === 'command' && hook.command) {
      const scriptPath = hook.command.replace(/^~/, os.homedir()).replace(/"/g, '');
      try {
        fs.accessSync(scriptPath, fs.constants.X_OK);
      } catch {
        console.warn(`WARNING: Hook script not found or not executable: ${scriptPath}`);
        console.warn('  Run: chmod +x ' + scriptPath);
      }
    }
  }
}

export function createServer({ testMode = false, worktreesEnabled } = {}) {
  const app = express();
  const server = http.createServer(app);

  // Whether sessions get isolated git worktrees. Defaults to the WORKTREES env
  // var; an explicit option overrides it (used by tests).
  const WORKTREES_ENABLED = worktreesEnabled !== undefined
    ? worktreesEnabled
    : worktreesEnabledFromEnv();

  function isAllowedOrigin(origin) {
    if (!origin) return true; // No Origin header (e.g., non-browser clients)
    try {
      const { hostname } = new URL(origin);
      if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
      if (/^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true; // Tailscale CGNAT range
      if (ALLOWED_ORIGIN_HOSTS.includes(hostname.toLowerCase())) return true; // extra origins via ALLOWED_ORIGINS
      return false;
    } catch {
      return false;
    }
  }

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ req }) => isAllowedOrigin(req.headers.origin),
  });
  const manager = new PtyManager();

  // In test mode, use bash instead of claude; in-memory SQLite
  const store = testMode ? createStore(':memory:') : createStore();
  const clients = new Set();
  // Tracks the active JSONL-capture poll interval per session so it can be
  // cleared on explicit kill/restart (removeAllListeners on kill would otherwise
  // orphan the onExit-registered clearInterval, leaking the loop).
  const capturePollers = new Map();
  // Sessions with an in-flight restart, to reject concurrent restarts that would
  // race in spawnSession ("already exists") or kill a freshly spawned process.
  const restarting = new Set();

  // Validate safety guardrails are in place (non-test only)
  if (!testMode) {
    const host = process.env.HOST || '127.0.0.1';
    const isRemote = host !== '127.0.0.1' && host !== 'localhost';
    validateHooksConfig({ strict: isRemote });
  }

  app.use(express.json({ limit: '16kb' }));

  // --- CORS / Origin validation for all API routes ---
  app.use('/api', (req, res, next) => {
    if (!isAllowedOrigin(req.headers.origin)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    const sessions = store.getAll().sessions;
    res.json({
      ok: true,
      sessions: sessions.length,
      uptime: process.uptime(),
    });
  });

  app.use(express.static(path.join(__dirname, 'public')));

  // --- Session-scoped file browser (for file tree) ---

  const BROWSE_ENTRY_LIMIT = 200;

  app.get('/api/browse', async (req, res, next) => {
    const { sessionId } = req.query;
    if (!sessionId) return next(); // fall through to original /api/browse handler

    const session = store.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const project = store.getProject(session.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Resolve browse root. scope=project browses the whole project directory
    // (which contains the worktrees); default stays inside this session's
    // worktree. Both remain contained by the resolved root check below.
    let worktreeRoot;
    try {
      worktreeRoot = await resolveScopedRoot(session, project, req.query.scope);
    } catch {
      return res.status(400).json({ error: 'Invalid worktree path' });
    }

    const relativePath = req.query.path || '';

    // Reject absolute paths
    if (path.isAbsolute(relativePath)) {
      return res.status(403).json({ error: 'Absolute paths not allowed' });
    }

    // Reject path traversal
    const normalized = path.normalize(relativePath || '.');
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    const resolved = relativePath ? path.resolve(worktreeRoot, normalized) : worktreeRoot;

    // Symlink-safe validation
    let realResolved, realRoot;
    try {
      realResolved = await fs.promises.realpath(resolved);
      realRoot = await fs.promises.realpath(worktreeRoot);
    } catch {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
      return res.status(403).json({ error: 'Path escapes worktree' });
    }

    let stat;
    try {
      stat = await fs.promises.stat(realResolved);
    } catch {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    let entries;
    try {
      entries = await fs.promises.readdir(realResolved, { withFileTypes: true });
    } catch {
      return res.status(400).json({ error: 'Cannot read directory' });
    }

    const allDirs = (await listDirNames(realResolved, entries))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const allFiles = entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const totalEntries = allDirs.length + allFiles.length;
    const dirs = allDirs.slice(0, BROWSE_ENTRY_LIMIT);
    const remaining = BROWSE_ENTRY_LIMIT - dirs.length;
    const files = allFiles.slice(0, Math.max(remaining, 0));
    const hasMore = totalEntries > BROWSE_ENTRY_LIMIT;

    const result = { dirs, files };
    if (hasMore) result.hasMore = true;
    res.json(result);
  });

  // --- Directory Browser ---

  app.get('/api/browse', async (req, res) => {
    const homedir = os.homedir();
    const requestedPath = req.query.path || homedir;

    let resolved;
    try {
      resolved = await fs.promises.realpath(requestedPath);
    } catch {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    // Security: must be under homedir or a configured BROWSE_ROOTS entry
    // (use path.sep to prevent prefix bypass e.g. /Users/abh vs /Users/abh2)
    if (!isWithinBrowseRoots(resolved, BROWSE_ROOTS)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    let stat;
    try {
      stat = await fs.promises.stat(resolved);
    } catch {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    let entries;
    try {
      entries = await fs.promises.readdir(resolved, { withFileTypes: true });
    } catch {
      return res.status(400).json({ error: 'Cannot read directory' });
    }

    const dirs = (await listDirNames(resolved, entries))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .slice(0, 500);

    const parent = resolved === '/' ? null : path.dirname(resolved);

    res.json({ path: resolved, parent, dirs });
  });

  // --- File Viewer ---

  const MAX_FILE_SIZE = 1024 * 1024; // 1MB

  app.get('/api/file', async (req, res) => {
    const { sessionId, path: filePath } = req.query;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }

    // Reject absolute paths
    if (path.isAbsolute(filePath)) {
      return res.status(403).json({ error: 'Absolute paths not allowed' });
    }

    // Reject path traversal
    const normalized = path.normalize(filePath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    const session = store.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const project = store.getProject(session.projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Resolve file root. scope=project reads from the whole project directory;
    // default stays inside this session's worktree.
    let worktreeRoot;
    try {
      worktreeRoot = await resolveScopedRoot(session, project, req.query.scope);
    } catch {
      return res.status(400).json({ error: 'Invalid worktree path' });
    }

    const resolved = path.resolve(worktreeRoot, normalized);

    // Symlink-safe: realpath and verify still under worktree root
    let realResolved;
    try {
      realResolved = await fs.promises.realpath(resolved);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }

    let realRoot;
    try {
      realRoot = await fs.promises.realpath(worktreeRoot);
    } catch {
      return res.status(400).json({ error: 'Worktree root not found' });
    }

    if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
      return res.status(403).json({ error: 'Path escapes worktree' });
    }

    // Stat the file
    let stat;
    try {
      stat = await fs.promises.stat(realResolved);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }

    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a file' });
    }

    if (stat.size > MAX_FILE_SIZE) {
      return res.status(413).json({ error: 'File too large (max 1MB)' });
    }

    // Read file and check for binary (null bytes in first 8KB)
    const content = await fs.promises.readFile(realResolved);
    const checkBytes = content.subarray(0, 8192);
    if (checkBytes.includes(0)) {
      return res.json({ isBinary: true });
    }

    res.type('text/plain').send(content.toString('utf-8'));
  });

  // --- Conversation history (transcript) ---

  const MAX_HISTORY_BYTES = 8 * 1024 * 1024; // 8MB transcript cap

  app.get('/api/history', async (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const session = store.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.claudeSessionId) {
      return res.json({ turns: [], note: 'No conversation recorded yet.' });
    }

    const project = store.getProject(session.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // The transcript lives in the Claude project dir derived from the session's
    // cwd (the worktree, if any), named <claudeSessionId>.jsonl.
    let cwd = project.cwd;
    if (session.worktreePath) {
      try {
        cwd = await resolveWorktreePath(project.cwd, session.worktreePath);
      } catch {
        return res.status(400).json({ error: 'Invalid worktree path' });
      }
    }

    let candidateDirs;
    try {
      candidateDirs = candidateTranscriptDirs(cwd, project.cwd);
    } catch {
      return res.status(404).json({ error: 'Transcript directory not found' });
    }

    let transcriptPath = null;
    let stat = null;
    for (const dir of candidateDirs) {
      const candidate = path.join(dir, `${session.claudeSessionId}.jsonl`);
      try {
        stat = await fs.promises.stat(candidate);
        transcriptPath = candidate;
        break;
      } catch {
        // not in this dir — try the next
      }
    }
    if (!transcriptPath) {
      return res.json({ turns: [], note: 'Transcript file not found.' });
    }
    if (stat.size > MAX_HISTORY_BYTES) {
      return res.status(413).json({ error: 'Transcript too large to display (>8MB).' });
    }

    let raw;
    try {
      raw = await fs.promises.readFile(transcriptPath, 'utf-8');
    } catch {
      return res.status(500).json({ error: 'Failed to read transcript' });
    }

    res.json({ turns: parseTranscript(raw) });
  });

  // --- Helpers ---

  function safeSend(ws, msg) {
    if (ws.readyState === 1) {
      try {
        ws.send(msg);
      } catch {
        // Client disconnected mid-send; ignore
      }
    }
  }

  function broadcastState() {
    const { projects, sessions } = store.getAll();
    const msg = JSON.stringify({
      type: 'state',
      worktreesEnabled: WORKTREES_ENABLED,
      projects,
      sessions: sessions.map((s) => ({
        ...s,
        alive: manager.isAlive(s.id),
      })),
    });
    for (const ws of clients) {
      safeSend(ws, msg);
    }
  }

  /** Derive the ~/.claude/projects/ directory for a given cwd. */
  function getClaudeProjectDir(cwd) {
    return path.join(
      os.homedir(), '.claude', 'projects',
      encodeClaudeProjectDir(fs.realpathSync(cwd)),
    );
  }

  /**
   * The set of Claude project dirs a session's transcript could live in: the
   * worktree dir AND the project-root dir (a resumed conversation appends to the
   * transcript for the path it was first started in — commonly the root, not the
   * worktree). Deduped. Used by capture, startup recovery, and /api/history.
   */
  function candidateTranscriptDirs(cwd, projectCwd) {
    return [...new Set([getClaudeProjectDir(cwd), getClaudeProjectDir(projectCwd)])];
  }

  const execFileAsync = promisify(execFile);

  /** Set of claudeSessionIds currently running as live agents (empty on error). */
  async function getRunningAgentIds() {
    try {
      const { stdout } = await execFileAsync('claude', ['agents', '--json'], {
        timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
      });
      return parseRunningAgentIds(stdout);
    } catch {
      return new Set(); // CLI missing / errored — treat as "none known running"
    }
  }

  async function spawnSession(session, { fork = false, runningAgents = null } = {}) {
    const project = store.getProject(session.projectId);
    if (!project) throw new Error('Project not found for session');

    let cwd = project.cwd;
    if (session.worktreePath) {
      try {
        cwd = await resolveWorktreePath(project.cwd, session.worktreePath);
      } catch (e) {
        const err = new Error(`Invalid worktree path for session: ${e.message}`);
        err.code = e.code || 'INVALID_WORKTREE_PATH';
        throw err;
      }
      // The worktree may have been removed (archived/deleted/cleaned up) while
      // the conversation transcript lives on. The transcript is independent of
      // the worktree, so fall back to the project root to resume it rather than
      // failing — we lose worktree isolation but keep the conversation.
      if (!fs.existsSync(cwd)) {
        console.warn(`[spawn] Worktree missing for ${session.name}; running in project root`);
        cwd = project.cwd;
      }
    }

    // If we'd resume a conversation that's ALREADY running as a live agent,
    // Claude refuses a plain --resume. Detect it up front and, unless the caller
    // opted to fork, surface a typed error so the UI can offer "Fork a copy".
    if (!testMode && session.claudeSessionId && !fork) {
      // Reuse a caller-provided set (startup resumes many sessions and the set
      // is global) to avoid spawning `claude agents --json` once per session.
      const running = runningAgents || await getRunningAgentIds();
      if (running.has(session.claudeSessionId)) {
        const err = new Error('This conversation is already running as a background agent. Fork a copy to work on it here.');
        err.code = 'SESSION_RUNNING_ELSEWHERE';
        throw err;
      }
    }

    // Capture the Claude session ID by watching ~/.claude/projects/ for the
    // transcript this run writes to (a new file, or a grown one if resumed).
    // Snapshot BEFORE spawn to catch the change the moment it happens.
    //
    // Also capture on the FORK path: `claude --resume X --fork-session` branches
    // the conversation into a NEW transcript (new id Y). Without capturing, the
    // store keeps pointing at X — /api/history shows the pre-fork transcript and
    // the next restart re-detects X as "running elsewhere" and loops forever.
    let captureDirs = null;
    let captureBefore = null;
    if (!testMode && (!session.claudeSessionId || fork)) {
      captureDirs = candidateTranscriptDirs(cwd, project.cwd);
      captureBefore = captureDirs.map((d) => snapshotTranscripts(fs, d));
    }

    const spawnOpts = {
      cwd,
      ...(testMode
        ? { shell: '/bin/bash', args: ['-c', 'sleep 5'] }
        : session.claudeSessionId
          ? { resumeId: session.claudeSessionId, fork }
          : {}),
    };

    try {
      manager.spawn(session.id, spawnOpts);
    } catch (e) {
      store.updateSession(session.id, { status: 'exited' });
      broadcastState();
      throw e;
    }

    manager.onExit(session.id, () => {
      store.updateSession(session.id, { status: 'exited' });
      broadcastState();
      const msg = JSON.stringify({ type: 'exited', sessionId: session.id });
      for (const ws of clients) {
        safeSend(ws, msg);
      }
    });

    if (captureDirs) {
      const MAX_POLL_MS = 60_000; // give up after 60s
      const startTime = Date.now();

      // Clear any prior poller for this session (e.g. a restart reusing the id)
      // so we never run two capture loops that could persist a wrong id.
      const prior = capturePollers.get(session.id);
      if (prior) clearInterval(prior);

      const stopPoll = () => {
        const t = capturePollers.get(session.id);
        if (t) { clearInterval(t); capturePollers.delete(session.id); }
      };

      const pollInterval = setInterval(() => {
        if (Date.now() - startTime > MAX_POLL_MS) {
          stopPoll();
          return;
        }
        // Check each watched dir; take the first that shows a new/grown transcript.
        for (let i = 0; i < captureDirs.length; i++) {
          const after = snapshotTranscripts(fs, captureDirs[i]);
          const active = detectActiveTranscript(captureBefore[i], after);
          if (active) {
            const claudeSessionId = active.replace(/\.jsonl$/, '');
            store.updateSession(session.id, { claudeSessionId });
            broadcastState();
            stopPoll();
            break;
          }
        }
      }, 500);

      capturePollers.set(session.id, pollInterval);
      // Stop polling when the process exits (natural exit path).
      manager.onExit(session.id, stopPoll);
    }
  }

  // Ensure the capture poller is cleared whenever we kill a session's process
  // directly (kill fires removeAllListeners, so the onExit stopPoll won't run).
  function killSession(sessionId) {
    const t = capturePollers.get(sessionId);
    if (t) { clearInterval(t); capturePollers.delete(sessionId); }
    manager.kill(sessionId);
  }

  // --- Projects REST API ---

  app.get('/api/projects', (req, res) => {
    const { projects, sessions } = store.getAll();
    res.json({
      projects,
      sessions: sessions.map((s) => ({
        ...s,
        alive: manager.isAlive(s.id),
      })),
    });
  });

  app.post('/api/projects', async (req, res) => {
    const { name, cwd } = req.body;
    if (!name || typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `name is required (string, max ${MAX_NAME_LENGTH} chars)` });
    }
    if (!cwd || typeof cwd !== 'string' || cwd.length > MAX_CWD_LENGTH) {
      return res.status(400).json({ error: `cwd is required (string, max ${MAX_CWD_LENGTH} chars)` });
    }

    const expanded = cwd.startsWith('~') ? cwd.replace(/^~/, os.homedir()) : cwd;
    const resolvedCwd = path.resolve(expanded);
    try {
      const stat = fs.statSync(resolvedCwd);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'cwd is not a directory' });
      }
    } catch {
      return res.status(400).json({ error: 'cwd does not exist' });
    }

    // Validate git repository
    const gitValidation = await validateGitRepo(resolvedCwd);
    if (!gitValidation.valid) {
      return res.status(400).json({
        error: gitValidation.message,
        code: gitValidation.code,
      });
    }

    const project = store.createProject({
      id: crypto.randomUUID(),
      name,
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
    });

    broadcastState();
    res.status(201).json(project);
  });

  app.delete('/api/projects/:id', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });

    const force = req.query.force === 'true';
    const projectSessions = store.getSessions(req.params.id);

    // Safety: unless forced, refuse to delete a project whose sessions have
    // uncommitted work. Without this, deleting a project force-removed every
    // worktree and force-deleted every branch with no warning, destroying
    // uncommitted (and, via branch -D, unmerged committed) work.
    if (!force) {
      const dirtySessions = [];
      for (const s of projectSessions) {
        if (!s.branchName) continue;
        try {
          if (await isWorktreeDirty(project.cwd, s.branchName)) {
            dirtySessions.push(s.name);
          }
        } catch (e) {
          // If we cannot verify, treat as unsafe so we don't silently discard work.
          if (e instanceof WorktreeDirtyCheckError && e.code === 'WORKTREE_MISSING') continue;
          dirtySessions.push(s.name);
        }
      }
      if (dirtySessions.length > 0) {
        return res.status(400).json({
          error: `Uncommitted changes in ${dirtySessions.length} session(s): ${dirtySessions.join(', ')}. Use force=true to delete anyway.`,
          code: 'DIRTY_WORKTREE',
          sessions: dirtySessions,
        });
      }
    }

    for (const s of projectSessions) {
      killSession(s.id);
      manager.killShell(s.id);
      const msg = JSON.stringify({ type: 'session-deleted', sessionId: s.id });
      for (const ws of clients) {
        safeSend(ws, msg);
      }
    }

    for (const s of projectSessions) {
      if (!s.branchName) continue;
      try {
        // Preserve branches (deleteBranch:false) so committed work survives as a
        // recoverable claude/<branch> ref even after the project is removed.
        await removeWorktree(project.cwd, s.branchName, project.id, { deleteBranch: false });
      } catch {
        // Best-effort cleanup
      }
    }

    store.deleteProject(req.params.id);
    broadcastState();
    res.json({ ok: true });
  });

  // --- Sessions REST API ---

  app.post('/api/projects/:id/sessions', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `name is required (string, max ${MAX_NAME_LENGTH} chars)` });
    }

    try {
      const stat = fs.statSync(project.cwd);
      if (!stat.isDirectory()) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Project directory no longer exists' });
    }

    const sessionId = crypto.randomUUID();
    // No-worktree mode: run directly in the project root (no branch/worktree).
    let branchName = null;
    let worktreePath = null;
    let worktreeWarning = null;

    if (WORKTREES_ENABLED) {
      branchName = `${sanitizeBranchName(name)}-${sessionId.slice(0, 7)}`;
      worktreePath = `.worktrees/${branchName}`;

      try {
        await createWorktree(project.cwd, branchName, project.id);
      } catch (e) {
        return res.status(400).json({
          error: e.message,
          code: e.code || 'WORKTREE_FAILED',
        });
      }

      try {
        const isIgnored = await isWorktreesIgnored(project.cwd);
        if (!isIgnored) {
          worktreeWarning = 'Warning: .worktrees/ is not in .gitignore. Add it to avoid committing worktree files.';
        }
      } catch {
        // Ignore check errors
      }
    }

    const session = store.createSession({
      id: sessionId,
      projectId: project.id,
      name,
      branchName,
      worktreePath,
      claudeSessionId: null,
      status: 'running',
      createdAt: new Date().toISOString(),
    });

    try {
      await spawnSession(session);
    } catch (e) {
      if (branchName) {
        try {
          await removeWorktree(project.cwd, branchName, project.id, { deleteBranch: true });
        } catch {
          // Ignore cleanup errors
        }
      }
      store.deleteSession(session.id);
      if (e.code === 'INVALID_WORKTREE_PATH' || e.code === 'PATH_SAFETY_VIOLATION') {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      return res.status(500).json({ error: `Failed to spawn: ${e.message}` });
    }

    broadcastState();
    const response = { ...session, alive: true };
    if (worktreeWarning) {
      response.warning = worktreeWarning;
    }
    res.status(201).json(response);
  });

  app.delete('/api/sessions/:id', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const project = store.getProject(session.projectId);
    const force = req.query.force === 'true';

    if (!force && session.branchName && project) {
      try {
        const dirty = await isWorktreeDirty(project.cwd, session.branchName);
        if (dirty) {
          return res.status(400).json({
            error: 'Worktree has uncommitted changes. Use force=true to delete anyway.',
            code: 'DIRTY_WORKTREE',
          });
        }
      } catch (e) {
        if (e instanceof WorktreeDirtyCheckError) {
          if (e.code !== 'WORKTREE_MISSING') {
            return res.status(400).json({
              error: 'Cannot verify worktree status. Use force=true to delete anyway.',
              code: e.code || 'DIRTY_CHECK_FAILED',
            });
          }
        } else {
          throw e;
        }
      }
    }

    killSession(session.id);
    manager.killShell(session.id);

    if (session.branchName && project) {
      try {
        // Preserve the branch (deleteBranch:false): the dirty check above only
        // catches uncommitted changes, so `git branch -D` here would silently
        // orphan committed-but-unmerged commits. The claude/<branch> ref remains
        // recoverable, matching archive semantics.
        await removeWorktree(project.cwd, session.branchName, project.id, { deleteBranch: false });
      } catch {
        // Ignore removal errors
      }
    }

    const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
    for (const ws of clients) {
      safeSend(ws, msg);
    }

    store.deleteSession(session.id);
    broadcastState();
    res.json({ ok: true });
  });

  app.post('/api/sessions/:id/archive', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const project = store.getProject(session.projectId);
    const force = req.query.force === 'true';

    if (!force && session.branchName && project) {
      try {
        const dirty = await isWorktreeDirty(project.cwd, session.branchName);
        if (dirty) {
          return res.status(400).json({
            error: 'Worktree has uncommitted changes. Use force=true to archive anyway.',
            code: 'DIRTY_WORKTREE',
          });
        }
      } catch (e) {
        if (e instanceof WorktreeDirtyCheckError) {
          if (e.code !== 'WORKTREE_MISSING') {
            return res.status(400).json({
              error: 'Cannot verify worktree status. Use force=true to archive anyway.',
              code: e.code || 'DIRTY_CHECK_FAILED',
            });
          }
        } else {
          throw e;
        }
      }
    }

    killSession(session.id);
    manager.killShell(session.id);

    const fullBranchName = session.branchName ? `claude/${session.branchName}` : null;

    if (session.branchName && project) {
      try {
        await removeWorktree(project.cwd, session.branchName, project.id, { deleteBranch: false });
      } catch {
        // Ignore removal errors
      }
    }

    const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
    for (const ws of clients) {
      safeSend(ws, msg);
    }

    store.deleteSession(session.id);
    broadcastState();

    res.json({
      ok: true,
      branch: fullBranchName,
      message: fullBranchName
        ? `Session archived. Branch '${fullBranchName}' preserved for recovery.`
        : 'Session archived.',
    });
  });

  // Merge a session's branch into the project's checked-out branch so the user
  // can run the changes from the project root. Auto-commits WIP, ff-if-possible.
  app.post('/api/sessions/:id/merge', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });
    if (!session.branchName) {
      return res.status(400).json({ error: 'Session has no branch to merge', code: 'NO_BRANCH' });
    }
    const project = store.getProject(session.projectId);
    if (!project) return res.status(400).json({ error: 'Parent project not found' });

    try {
      const result = await mergeSessionToMain(project.cwd, session.branchName, project.id);
      const how = result.fastForward ? 'fast-forwarded' : 'merged';
      res.json({
        ok: true,
        ...result,
        message: `${how} '${result.branch}' into your local branch${result.committed ? ' (auto-committed pending changes)' : ''}.`,
      });
    } catch (e) {
      const status = (e.code === 'MERGE_CONFLICT' || e.code === 'MAIN_DIRTY' || e.code === 'SESSION_BUSY') ? 409 : 400;
      res.status(status).json({ error: e.message, code: e.code || 'MERGE_FAILED' });
    }
  });

  // --- Orphan Cleanup ---

  let cleanupTimer = null;
  let isCleanupRunning = false;

  app.post('/api/cleanup', async (req, res) => {
    if (isCleanupRunning) {
      return res.status(429).json({ error: 'Cleanup already in progress' });
    }
    isCleanupRunning = true;
    try {
      const result = await cleanupOrphanedWorktrees(store, {
        gracePeriodMs: testMode ? 0 : undefined,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: `Cleanup failed: ${e.message}` });
    } finally {
      isCleanupRunning = false;
    }
  });

  app.post('/api/sessions/:id/restart', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    // Concurrency guard: reject overlapping restarts of the same session.
    // Claim the guard SYNCHRONOUSLY (before any await) so two requests can't
    // both pass the check while one is awaiting worktreeExists below.
    if (restarting.has(session.id)) {
      return res.status(409).json({ error: 'Restart already in progress', code: 'RESTART_IN_PROGRESS' });
    }
    restarting.add(session.id);

    try {
      const project = store.getProject(session.projectId);
      if (!project) return res.status(400).json({ error: 'Parent project not found' });

      try {
        const stat = fs.statSync(project.cwd);
        if (!stat.isDirectory()) throw new Error();
      } catch {
        return res.status(400).json({ error: 'Project directory no longer exists' });
      }

      // If the worktree is gone, we can still resume the conversation in the
      // project root (the transcript is independent of the worktree). Only
      // refuse when there's no saved conversation to fall back to.
      let worktreeGone = false;
      if (session.branchName) {
        worktreeGone = !(await worktreeExists(project.cwd, session.branchName));
        if (worktreeGone && !session.claudeSessionId) {
          return res.status(400).json({
            error: 'Worktree no longer exists and this session has no saved conversation to resume.',
            code: 'WORKTREE_MISSING',
          });
        }
      }

      killSession(session.id);
      store.updateSession(session.id, { status: 'running' });
      const updatedSession = store.getSession(session.id);

      // ?fork=true branches a copy so a conversation already running elsewhere
      // can be worked on here (Claude refuses a plain --resume in that case).
      const fork = req.query.fork === 'true';

      try {
        await spawnSession(updatedSession, { fork });
      } catch (e) {
        // Spawn failed: don't leave a zombie row marked 'running' with no process.
        store.updateSession(session.id, { status: 'exited' });
        broadcastState();
        if (e.code === 'SESSION_RUNNING_ELSEWHERE') {
          // Not a hard failure — the UI should offer to fork.
          return res.status(409).json({ error: e.message, code: e.code });
        }
        if (e.code === 'INVALID_WORKTREE_PATH' || e.code === 'PATH_SAFETY_VIOLATION') {
          return res.status(400).json({ error: e.message, code: e.code });
        }
        return res.status(500).json({ error: `Failed to spawn: ${e.message}` });
      }

      broadcastState();
      res.json({ ...store.getSession(session.id), alive: true, ranInProjectRoot: worktreeGone });
    } finally {
      restarting.delete(session.id);
    }
  });

  // --- WebSocket ---

  wss.on('connection', (ws) => {
    clients.add(ws);
    let attachedSessionId = null;

    // Socket-level errors (abnormal resets, malformed frames) are emitted on the
    // ws EventEmitter independently of message handling. Without a listener,
    // Node re-throws the 'error' event and crashes the whole server, orphaning
    // every other session. Swallow-and-log; 'close' fires afterward for cleanup.
    ws.on('error', (e) => {
      console.error('[ws] socket error:', e && e.message);
    });

    // Send initial state
    const { projects, sessions } = store.getAll();
    safeSend(
      ws,
      JSON.stringify({
        type: 'state',
        worktreesEnabled: WORKTREES_ENABLED,
        projects,
        sessions: sessions.map((s) => ({
          ...s,
          alive: manager.isAlive(s.id),
        })),
      })
    );

    // Track the current data listener so we can remove it on detach
    let dataListener = null;
    let shellDataListener = null;
    let attachedShellSessionId = null;

    // --- Batched output: accumulate PTY chunks and flush every ~16ms ---
    const BATCH_INTERVAL_MS = 16;
    const BATCH_MAX_BYTES = 64 * 1024; // flush if batch exceeds 64KB
    let claudeBatch = '';
    let claudeBatchTimer = null;
    let shellBatch = '';
    let shellBatchTimer = null;
    let resizeNudgeTimer = null;

    function flushClaudeBatch() {
      clearTimeout(claudeBatchTimer);
      claudeBatchTimer = null;
      if (claudeBatch && attachedSessionId) {
        safeSend(ws, JSON.stringify({ type: 'output', sessionId: attachedSessionId, data: claudeBatch }));
        claudeBatch = '';
      }
    }

    function flushShellBatch() {
      clearTimeout(shellBatchTimer);
      shellBatchTimer = null;
      if (shellBatch && attachedShellSessionId) {
        safeSend(ws, JSON.stringify({ type: 'shell-output', sessionId: attachedShellSessionId, data: shellBatch }));
        shellBatch = '';
      }
    }

    function batchClaudeOutput(data) {
      claudeBatch += data;
      if (claudeBatch.length >= BATCH_MAX_BYTES) {
        flushClaudeBatch();
      } else if (!claudeBatchTimer) {
        claudeBatchTimer = setTimeout(flushClaudeBatch, BATCH_INTERVAL_MS);
      }
    }

    function batchShellOutput(data) {
      shellBatch += data;
      if (shellBatch.length >= BATCH_MAX_BYTES) {
        flushShellBatch();
      } else if (!shellBatchTimer) {
        shellBatchTimer = setTimeout(flushShellBatch, BATCH_INTERVAL_MS);
      }
    }

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      try {
      switch (msg.type) {
        case 'attach': {
          const { sessionId, cols, rows } = msg;
          const proc = manager.getProcess(sessionId);

          // Detach from previous session regardless of whether new attach succeeds
          if (attachedSessionId && dataListener) {
            flushClaudeBatch();
            manager.offData(attachedSessionId, dataListener);
            dataListener = null;
          }

          // Reject attach if process doesn't exist or is dead
          if (!proc || !manager.isAlive(sessionId)) {
            attachedSessionId = null;
            safeSend(ws, JSON.stringify({ type: 'attach-error', sessionId }));
            break;
          }

          attachedSessionId = sessionId;

          // Resize before replay
          if (cols && rows) {
            manager.resize(sessionId, cols, rows);
          }

          // Install the live listener FIRST to capture everything.
          // Buffer data until replay is done, then switch to direct forwarding.
          const pendingData = [];
          let replaying = true;

          dataListener = (d) => {
            if (replaying) {
              pendingData.push(d);
            } else {
              batchClaudeOutput(d);
            }
          };
          manager.onData(sessionId, dataListener);

          // Replay buffer in a single message to reduce write-queue churn
          const buffer = manager.getBuffer(sessionId);
          if (buffer.length > 0) {
            const combined = buffer.join('');
            safeSend(ws, JSON.stringify({ type: 'output', sessionId, data: combined }));
          }

          // Flush any data that arrived during replay via batch, then switch to live
          replaying = false;
          for (const d of pendingData) {
            claudeBatch += d;
          }
          flushClaudeBatch();

          // Send replay-done AFTER all data (buffer + pending) is sent
          safeSend(ws, JSON.stringify({ type: 'replay-done', sessionId }));

          // Nudge Claude CLI to re-render by triggering a SIGWINCH via
          // a tiny resize bounce. Ink (Claude's TUI) listens for this and
          // repaints, restoring correct cursor position and visibility.
          if (cols && rows && manager.isAlive(sessionId)) {
            const nudgeCols = Math.max(cols - 1, 1);
            manager.resize(sessionId, nudgeCols, rows);
            setTimeout(() => {
              manager.resize(sessionId, cols, rows);
            }, 50);
          }
          break;
        }

        case 'input': {
          if (attachedSessionId) {
            manager.write(attachedSessionId, msg.data);
          }
          break;
        }

        case 'resize': {
          if (attachedSessionId && msg.cols && msg.rows) {
            // SIGWINCH nudge: bounce resize to force Ink (Claude's TUI) to
            // fully repaint the text input area. Uses a cancelable timer so
            // rapid resizes (e.g. window drag) don't stack stale timeouts.
            clearTimeout(resizeNudgeTimer);
            const nudgeCols = Math.max(msg.cols - 1, 1);
            manager.resize(attachedSessionId, nudgeCols, msg.rows);
            resizeNudgeTimer = setTimeout(() => {
              if (attachedSessionId && manager.isAlive(attachedSessionId)) {
                manager.resize(attachedSessionId, msg.cols, msg.rows);
              }
            }, 50);
          }
          break;
        }

        case 'shell-attach': {
          const { sessionId, cols, rows } = msg;
          console.log('[shell-attach] sessionId:', sessionId, 'cols:', cols, 'rows:', rows);
          const session = store.getSession(sessionId);
          if (!session) { console.log('[shell-attach] session not found'); break; }

          const project = store.getProject(session.projectId);
          if (!project) { console.log('[shell-attach] project not found'); break; }

          // Detach previous shell listener (use dedicated tracking variable
          // since attachedSessionId may already point to the new session)
          if (attachedShellSessionId && shellDataListener) {
            flushShellBatch();
            manager.offShellData(attachedShellSessionId, shellDataListener);
            shellDataListener = null;
          }
          attachedShellSessionId = sessionId;

          // Spawn shell if not already running. The shell opens at the PROJECT
          // ROOT (not the session worktree) so it sees the real repo/files;
          // the worktree is still reachable under .worktrees/<branch>.
          if (!manager.isShellAlive(sessionId)) {
            const cwd = project.cwd;
            console.log('[shell-attach] spawning shell in project root:', cwd);
            manager.spawnShell(sessionId, { cwd, cols, rows });
            // Notify the client when this shell exits (e.g. user types `exit`)
            // so the UI can show a hint and re-attach spawns a fresh shell.
            manager.onShellExit(sessionId, () => {
              const m = JSON.stringify({ type: 'shell-exited', sessionId });
              for (const c of clients) safeSend(c, m);
            });
          } else if (cols && rows) {
            manager.resizeShell(sessionId, cols, rows);
          }

          // Install live listener with replay buffering (same pattern as attach)
          const shellPending = [];
          let shellReplaying = true;

          shellDataListener = (d) => {
            if (shellReplaying) {
              shellPending.push(d);
            } else {
              batchShellOutput(d);
            }
          };
          manager.onShellData(sessionId, shellDataListener);

          // Replay buffer
          const shellBuffer = manager.getShellBuffer(sessionId);
          if (shellBuffer.length > 0) {
            const combined = shellBuffer.join('');
            safeSend(ws, JSON.stringify({ type: 'shell-output', sessionId, data: combined }));
          }

          // Flush pending via batch, then switch to live
          shellReplaying = false;
          for (const d of shellPending) {
            shellBatch += d;
          }
          flushShellBatch();

          safeSend(ws, JSON.stringify({ type: 'shell-replay-done', sessionId }));
          break;
        }

        case 'shell-input': {
          if (msg.sessionId) {
            manager.writeShell(msg.sessionId, msg.data);
          }
          break;
        }

        case 'shell-resize': {
          if (msg.sessionId && msg.cols && msg.rows) {
            manager.resizeShell(msg.sessionId, msg.cols, msg.rows);
          }
          break;
        }

        case 'image-upload': {
          const { sessionId, data: b64Data } = msg;
          if (!sessionId || !b64Data) {
            safeSend(ws, JSON.stringify({ type: 'image-upload-error', error: 'Missing sessionId or data' }));
            break;
          }

          const session = store.getSession(sessionId);
          if (!session) {
            safeSend(ws, JSON.stringify({ type: 'image-upload-error', error: 'Session not found' }));
            break;
          }

          const project = store.getProject(session.projectId);
          if (!project) {
            safeSend(ws, JSON.stringify({ type: 'image-upload-error', error: 'Project not found' }));
            break;
          }

          // Decode base64
          let buf;
          try {
            buf = Buffer.from(b64Data, 'base64');
          } catch {
            safeSend(ws, JSON.stringify({ type: 'image-upload-error', error: 'Invalid base64 data' }));
            break;
          }

          // 10MB limit
          if (buf.length > 10 * 1024 * 1024) {
            safeSend(ws, JSON.stringify({ type: 'image-upload-error', error: 'Image too large (max 10MB)' }));
            break;
          }

          // Validate magic bytes and determine extension
          const magic = buf.subarray(0, 12);
          let ext;
          if (magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4E && magic[3] === 0x47) {
            ext = 'png';
          } else if (magic[0] === 0xFF && magic[1] === 0xD8 && magic[2] === 0xFF) {
            ext = 'jpg';
          } else if (magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x38) {
            ext = 'gif';
          } else if (magic.length >= 12 && magic[0] === 0x52 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x46
                     && magic[8] === 0x57 && magic[9] === 0x45 && magic[10] === 0x42 && magic[11] === 0x50) {
            ext = 'webp';
          } else {
            safeSend(ws, JSON.stringify({ type: 'image-upload-error', error: 'Not a valid image (PNG, JPEG, GIF, WebP)' }));
            break;
          }

          // Resolve worktree root for session-scoped storage
          let worktreeRoot;
          if (session.worktreePath) {
            try {
              worktreeRoot = await resolveWorktreePath(project.cwd, session.worktreePath);
            } catch {
              safeSend(ws, JSON.stringify({ type: 'image-upload-error', error: 'Cannot resolve worktree' }));
              break;
            }
          } else {
            worktreeRoot = project.cwd;
          }

          const uploadDir = path.join(worktreeRoot, '.claude-uploads');
          const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;

          try {
            await fs.promises.mkdir(uploadDir, { recursive: true });
            const filePath = path.join(uploadDir, filename);
            await fs.promises.writeFile(filePath, buf, { flag: 'wx' });
            safeSend(ws, JSON.stringify({ type: 'image-upload-ok', path: filePath }));
          } catch (e) {
            safeSend(ws, JSON.stringify({ type: 'image-upload-error', error: `Save failed: ${e.message}` }));
          }
          break;
        }
      }
      } catch (e) {
        // A single malformed/racy message must never crash the server and
        // take down every other session. Log and keep the socket alive.
        console.error(`[ws] Error handling '${msg.type}' message:`, e.message);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      clearTimeout(claudeBatchTimer);
      clearTimeout(shellBatchTimer);
      if (attachedSessionId && dataListener) {
        manager.offData(attachedSessionId, dataListener);
      }
      if (attachedShellSessionId && shellDataListener) {
        manager.offShellData(attachedShellSessionId, shellDataListener);
      }
    });
  });

  // Server-level error listeners so a listen/accept error (e.g. EADDRINUSE) or a
  // WebSocketServer error surfaces as a log line rather than an uncaught crash.
  wss.on('error', (e) => console.error('[wss] server error:', e && e.message));
  server.on('error', (e) => console.error('[http] server error:', e && e.message));

  // --- Startup: recover missing Claude session IDs, then resume ---

  if (!testMode) {
    const sessions = store.getAll().sessions;

    // Scan a Claude project dir once for real conversation transcripts (skipping
    // stub files that contain only file-history-snapshot entries), memoized so a
    // dir shared by many sessions (the project root) is read only once per boot
    // rather than once per session.
    const dirScanCache = new Map();
    const scanConversationDir = (dir) => {
      if (dirScanCache.has(dir)) return dirScanCache.get(dir);
      const found = [];
      let names;
      try { names = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); }
      catch { dirScanCache.set(dir, found); return found; }
      for (const f of names) {
        try {
          const content = fs.readFileSync(path.join(dir, f), 'utf8');
          const hasConversation = content.split('\n').filter(Boolean).some(line => {
            try {
              const t = JSON.parse(line).type;
              return t && t !== 'file-history-snapshot';
            } catch { return false; }
          });
          if (hasConversation) {
            found.push({ id: f.replace(/\.jsonl$/, ''), mtime: fs.statSync(path.join(dir, f)).mtimeMs });
          }
        } catch { /* unreadable — skip */ }
      }
      dirScanCache.set(dir, found);
      return found;
    };

    // First pass: resolve the latest Claude session ID for every resumable session.
    // This handles: null IDs (polling failed), stale IDs (/clear created new JSONL),
    // deleted JSONL files, and exited sessions that can be revived.
    for (const session of sessions) {
      if (session.status !== 'running' && session.status !== 'exited') continue;

      const project = store.getProject(session.projectId);
      if (!project) continue;

      try {
        let cwd = project.cwd;
        if (session.worktreePath) {
          // Apply the same safety checks as resolveWorktreePath (sync version)
          const normalized = path.normalize(session.worktreePath);
          if (path.isAbsolute(session.worktreePath)
            || normalized === '..' || normalized.startsWith(`..${path.sep}`)
            || (!normalized.startsWith(`.worktrees${path.sep}`) && normalized !== '.worktrees')) {
            console.warn(`[startup] Invalid worktree path for ${session.name}, marking exited`);
            store.updateSession(session.id, { status: 'exited' });
            continue;
          }
          const resolved = fs.realpathSync(path.resolve(project.cwd, normalized));
          const resolvedProject = fs.realpathSync(project.cwd);
          if (!resolved.startsWith(resolvedProject + path.sep)) {
            console.warn(`[startup] Worktree path escapes project for ${session.name}, marking exited`);
            store.updateSession(session.id, { status: 'exited' });
            continue;
          }
          cwd = resolved;
        }
        // A resumed conversation's transcript may live under the worktree dir OR
        // the project-root dir. Scan both (cached per dir across sessions).
        const conv = candidateTranscriptDirs(cwd, project.cwd).flatMap(scanConversationDir);

        // Prefer to KEEP the session's existing id if its transcript still
        // exists (avoids cross-wiring to some other session sharing the dir).
        const existing = session.claudeSessionId && conv.find(c => c.id === session.claudeSessionId);
        conv.sort((a, b) => b.mtime - a.mtime);
        const chosen = existing ? session.claudeSessionId : (conv[0] && conv[0].id);

        if (chosen) {
          if (chosen !== session.claudeSessionId || session.status === 'exited') {
            store.updateSession(session.id, { claudeSessionId: chosen, status: 'running' });
            console.log(`[startup] Session ID for ${session.name}: ${chosen}${session.claudeSessionId ? ` (was ${session.claudeSessionId})` : ' (was null)'}${session.status === 'exited' ? ' (revived)' : ''}`);
          }
        } else {
          console.warn(`[startup] No conversation transcript found for ${session.name}, marking exited`);
          store.updateSession(session.id, { status: 'exited' });
        }
      } catch (err) {
        console.warn(`[startup] Could not resolve session ID for ${session.name}: ${err.message}`);
        store.updateSession(session.id, { status: 'exited' });
      }
    }

    // Second pass: resume sessions that have a claudeSessionId.
    // spawnSession is async: it MUST be awaited inside a try/catch, else a
    // rejection (bad worktree, spawn failure) becomes an unhandled rejection
    // that crashes the just-started server and crash-loops recovery. Run in an
    // async IIFE so each session is awaited and failures are contained.
    (async () => {
      const updatedSessions = store.getAll().sessions;
      // The running-agent set is global; fetch it once for the whole pass rather
      // than spawning `claude agents --json` per session.
      const runningAgents = await getRunningAgentIds();
      for (const session of updatedSessions) {
        if (session.status === 'running' && session.claudeSessionId) {
          const project = store.getProject(session.projectId);
          if (!project) {
            store.updateSession(session.id, { status: 'exited' });
            continue;
          }
          try {
            const stat = fs.statSync(project.cwd);
            if (!stat.isDirectory()) throw new Error();
          } catch {
            console.error(`Project cwd missing for ${session.name}, marking exited`);
            store.updateSession(session.id, { status: 'exited' });
            continue;
          }
          try {
            await spawnSession(session, { runningAgents });
            console.log(`Resumed session: ${session.name}`);
          } catch (e) {
            console.error(`Failed to resume ${session.name}: ${e.message}`);
            store.updateSession(session.id, { status: 'exited' });
          }
        }
      }
      broadcastState();
    })().catch((e) => console.error('[startup] resume pass failed:', e && e.message));
  }

  // --- Periodic Orphan Cleanup ---

  const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

  async function runCleanup() {
    if (isCleanupRunning) {
      console.log('[cleanup] Skipping — previous cleanup still running');
      return;
    }
    isCleanupRunning = true;
    try {
      await cleanupOrphanedWorktrees(store);
    } catch (e) {
      console.error(`[cleanup] Cleanup failed: ${e.message}`);
    } finally {
      isCleanupRunning = false;
    }
  }

  if (!testMode) {
    // Run cleanup on startup (async, don't block server start)
    runCleanup();

    // Schedule periodic cleanup
    cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  }

  server.destroy = () => {
    return new Promise((resolve) => {
      if (cleanupTimer) clearInterval(cleanupTimer);
      manager.destroyAll();
      manager.destroyAllShells();
      store.close();
      wss.close();
      for (const client of clients) {
        client.terminate();
      }
      clients.clear();
      server.close(resolve);
    });
  };

  // Return server (not app) so WebSocket upgrade works
  return server;
}

// Run if executed directly (ESM-safe check)
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = process.env.PORT || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Claude Console running at http://${host}:${port}`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received. Shutting down gracefully...`);
    await server.destroy();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // Last-resort backstops: keep the server (and everyone's sessions) alive when
  // a stray async error escapes. We log rather than exit — a single bad code
  // path must not orphan every running PTY. Fatal, unrecoverable errors will
  // still surface in the logs for diagnosis.
  process.on('uncaughtException', (e) => {
    console.error('[fatal] uncaughtException:', e && e.stack || e);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection:', reason && reason.stack || reason);
  });
}
