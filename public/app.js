// app.js
(function () {
  'use strict';

  // --- State ---
  let ws = null;
  let term = null;
  let fitAddon = null;
  let activeSessionId = null;
  let projects = [];
  let sessions = [];
  let expandedProjects = new Set();
  // Locked sessions: shown but inert (no hover/click/select), like locking a
  // track in a video editor. Persisted in localStorage.
  const LOCKED_SESSIONS_KEY = 'claude-console:lockedSessions';
  const lockedSessions = new Set(loadLockedSessions());
  function loadLockedSessions() {
    try { return JSON.parse(localStorage.getItem(LOCKED_SESSIONS_KEY) || '[]'); }
    catch { return []; }
  }
  function saveLockedSessions() {
    try { localStorage.setItem(LOCKED_SESSIONS_KEY, JSON.stringify([...lockedSessions])); }
    catch {}
  }
  let initialStateApplied = false; // expand all projects on first state after load
  let browseScope = 'worktree'; // 'worktree' (session dir) or 'project' (repo root)
  let reconnectDelay = 1000;
  let toastTimeout = null;
  let shellTerm = null;
  let shellFitAddon = null;
  let expandedDirs = new Set(); // tracks expanded directory paths in file tree
  let openTabs = []; // { id, filename, fullPath, content, type }
  let activeTabId = 'claude';
  // Select mode: when true, strip Claude's mouse-tracking so the wheel scrolls
  // xterm locally (fast) and drag selects/copies text. When false, Claude keeps
  // the mouse (its own scroll + clickable UI). Default OFF.
  let selectMode = false;
  // Fixed, never-closeable tabs — single source for rendering, Alt+Tab cycling,
  // and the closeable-tab guard. Add/rename a fixed tab here only.
  const FIXED_TABS = [
    { id: 'claude', label: 'Claude' },
    { id: 'history', label: 'History' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'files', label: 'Files' },
  ];
  const FIXED_TAB_IDS = FIXED_TABS.map((t) => t.id);

  // --- Sticky scroll state ---
  const NEAR_BOTTOM_LINES = 2;
  let claudeSticky = true;
  let claudePendingScroll = false;
  let shellSticky = true;
  let shellPendingScroll = false;
  let shellDead = false; // set when the shell process exits; triggers re-attach

  // Attach auto-scroll: force scroll-to-bottom on every write during session
  // attach until output settles. Covers replay buffer + SIGWINCH re-render.
  let claudeAttachScroll = false;
  let claudeAttachTimer = null;
  let shellAttachScroll = false;
  let shellAttachTimer = null;
  const ATTACH_SETTLE_MS = 300;

  function isNearBottom(t) {
    const buf = t.buffer.active;
    // Alternate screen (e.g. vim, less) has no scrollback; always "at bottom"
    if (buf.type === 'alternate') return true;
    return (buf.baseY - buf.viewportY) <= NEAR_BOTTOM_LINES;
  }

  // Release sticky-follow when the user scrolls up. During active streaming the
  // onScroll handler is guarded by claudePendingScroll (which is nearly always
  // set mid-write), so genuine user scroll-ups get swallowed and auto-scroll
  // yanks the view back to the bottom. Wheel/touch "up" is unambiguous user
  // intent, so honor it immediately and stop generating auto-scrolls. The
  // onScroll handler re-enables sticky once the user returns to the bottom.
  function releaseClaudeStick() {
    claudeSticky = false;
    claudePendingScroll = false;
    claudeAttachScroll = false;
    clearTimeout(claudeAttachTimer);
  }
  function releaseShellStick() {
    shellSticky = false;
    shellPendingScroll = false;
    shellAttachScroll = false;
    clearTimeout(shellAttachTimer);
  }

  // Attach wheel/touch "scroll up" intent detection to a terminal's container.
  function attachScrollIntent(containerEl, release) {
    containerEl.addEventListener('wheel', (e) => {
      if (e.deltaY < 0) release();
    }, { passive: true });

    let lastTouchY = null;
    containerEl.addEventListener('touchstart', (e) => {
      lastTouchY = e.touches[0] ? e.touches[0].clientY : null;
    }, { passive: true });
    containerEl.addEventListener('touchmove', (e) => {
      if (lastTouchY == null || !e.touches[0]) return;
      const y = e.touches[0].clientY;
      if (y > lastTouchY) release(); // finger moved down → viewing older output
      lastTouchY = y;
    }, { passive: true });
  }

  // --- DOM refs ---
  const projectListEl = document.getElementById('project-list');
  const terminalEl = document.getElementById('terminal');
  const noSession = document.getElementById('no-session');
  const btnAddProject = document.getElementById('btn-add-project');
  const btnHomeAddProject = document.getElementById('btn-home-add-project');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalProjectName = document.getElementById('modal-project-name');
  const modalProjectPath = document.getElementById('modal-project-path');
  const btnBrowse = document.getElementById('btn-browse');
  const dirBrowser = document.getElementById('dir-browser');
  const dirBreadcrumbs = document.getElementById('dir-breadcrumbs');
  const dirList = document.getElementById('dir-list');
  const btnSelectDir = document.getElementById('btn-select-dir');
  const btnModalCancel = document.getElementById('btn-modal-cancel');
  const btnModalCreate = document.getElementById('btn-modal-create');
  const shellPane = document.getElementById('shell-pane');
  const filesPane = document.getElementById('files-pane');
  const historyPane = document.getElementById('history-pane');
  const historyContent = document.getElementById('history-content');
  const historyStatus = document.getElementById('history-status');
  const historyRefresh = document.getElementById('history-refresh');
  const filesScopeToggle = document.getElementById('files-scope-toggle');
  const shellTerminalEl = document.getElementById('shell-terminal');
  const rightPanelPath = document.getElementById('right-panel-path');
  const fileTreeEl = document.getElementById('file-tree');
  const tabBar = document.getElementById('tab-bar');
  const tabList = document.getElementById('tab-list');
  const fileViewer = document.getElementById('file-viewer');
  const fileViewerPath = document.getElementById('file-viewer-path');
  const fileViewerRefresh = document.getElementById('file-viewer-refresh');
  const fileViewerContent = document.getElementById('file-viewer-content');

  // --- Mobile responsive DOM refs ---
  const sidebarEl = document.getElementById('sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const mobileHamburger = document.getElementById('mobile-hamburger');
  const mobileSessionInfo = document.getElementById('mobile-session-info');
  const mobileSessionName = document.getElementById('mobile-session-name');
  const mobileStatusDot = document.getElementById('mobile-status-dot');
  const mobileNewSession = document.getElementById('mobile-new-session');

  // --- Mobile sidebar ---
  const mobileQuery = window.matchMedia('(max-width: 768px)');
  function isMobile() {
    return mobileQuery.matches;
  }

  function openMobileSidebar() {
    sidebarEl.classList.add('open');
    sidebarBackdrop.classList.add('visible');
    document.body.classList.add('sidebar-open');
    sidebarEl.setAttribute('aria-hidden', 'false');
    document.getElementById('terminal-container').setAttribute('aria-hidden', 'true');
    mobileHamburger.setAttribute('aria-label', 'Close menu');
    // Focus first focusable element in sidebar
    const firstFocusable = sidebarEl.querySelector('button, [tabindex]:not([tabindex="-1"])');
    if (firstFocusable) firstFocusable.focus();
  }

  function closeMobileSidebar() {
    sidebarEl.classList.remove('open');
    sidebarBackdrop.classList.remove('visible');
    document.body.classList.remove('sidebar-open');
    sidebarEl.setAttribute('aria-hidden', 'true');
    document.getElementById('terminal-container').removeAttribute('aria-hidden');
    mobileHamburger.setAttribute('aria-label', 'Open menu');
    mobileHamburger.focus();
  }

  function updateMobileTopbar() {
    if (!activeSessionId) {
      mobileSessionName.textContent = 'Claude Console';
      mobileStatusDot.className = 'status-dot';
      mobileStatusDot.classList.add('hidden');
      mobileNewSession.classList.add('hidden');
      return;
    }
    const session = sessions.find(s => s.id === activeSessionId);
    if (session) {
      mobileSessionName.textContent = session.name;
      mobileStatusDot.className = 'status-dot ' + (session.alive ? 'alive' : 'exited');
      mobileStatusDot.classList.remove('hidden');
      mobileNewSession.classList.remove('hidden');
    }
  }

  // --- Helpers ---
  let disconnectWarnedAt = 0;
  const connectionBanner = document.getElementById('connection-banner');

  // Reflect WS connection state in the UI: show a reconnecting banner and dim
  // status dots (liveness is unknown while disconnected).
  function setConnected(connected) {
    if (connectionBanner) connectionBanner.classList.toggle('hidden', connected);
    document.body.classList.toggle('ws-disconnected', !connected);
  }

  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      return true;
    }
    // Dropped because the socket is down — warn the user (throttled) so typing
    // into a disconnected terminal isn't silently lost.
    const now = performance.now();
    if (now - disconnectWarnedAt > 3000) {
      disconnectWarnedAt = now;
      showToast('Disconnected — input not sent. Reconnecting…', 'warning', 3000);
    }
    return false;
  }

  function debounce(fn, ms) {
    let timer;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  function relativeTime(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  // --- Toast notifications ---
  function showToast(message, type = 'info', duration = 4000) {
    // Remove existing toast if any
    const existing = document.getElementById('toast');
    if (existing) {
      existing.remove();
      clearTimeout(toastTimeout);
    }

    const toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // --- Confirmation dialog ---
  function showConfirmDialog(title, message, onConfirm, onCancel, confirmLabel = 'Delete Anyway', extraButton = null) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const titleEl = document.createElement('h3');
    titleEl.textContent = title;

    const messageEl = document.createElement('p');
    messageEl.textContent = message;

    const buttons = document.createElement('div');
    buttons.className = 'confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => {
      overlay.remove();
      document.removeEventListener('keydown', handleEscape);
      if (onCancel) onCancel();
    };

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'confirm-ok';
    confirmBtn.textContent = confirmLabel;
    confirmBtn.onclick = () => {
      overlay.remove();
      document.removeEventListener('keydown', handleEscape);
      if (onConfirm) onConfirm();
    };

    buttons.appendChild(cancelBtn);
    // Optional third action (e.g. "New Session") between Cancel and Confirm.
    if (extraButton && extraButton.label) {
      const extraBtn = document.createElement('button');
      extraBtn.className = 'confirm-extra';
      extraBtn.textContent = extraButton.label;
      extraBtn.onclick = () => {
        overlay.remove();
        document.removeEventListener('keydown', handleEscape);
        if (extraButton.onClick) extraButton.onClick();
      };
      buttons.appendChild(extraBtn);
    }
    buttons.appendChild(confirmBtn);
    dialog.appendChild(titleEl);
    dialog.appendChild(messageEl);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Close on overlay click
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        overlay.remove();
        document.removeEventListener('keydown', handleEscape);
        if (onCancel) onCancel();
      }
    };

    // Close on Escape
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', handleEscape);
        if (onCancel) onCancel();
      }
    };
    document.addEventListener('keydown', handleEscape);
  }

  // Write text to the clipboard, robust to "Document is not focused" errors.
  // The async Clipboard API (navigator.clipboard.writeText) rejects when the
  // page lacks focus (common with an xterm canvas / inside a tunnel). The
  // legacy hidden-textarea + execCommand('copy') path runs synchronously in the
  // user gesture and needs neither focus nor a permission prompt, so we try it
  // first and fall back to the async API.
  function copyTextToClipboard(text) {
    if (!text) return;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) return;
    } catch { /* fall through to async API */ }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  // Strip the escape sequences Claude's TUI uses to enable mouse tracking
  // (DECSET/DECRST modes 1000–1006, 1015). Long conversations switch Claude
  // into full TUI mode, which turns mouse tracking ON and makes xterm forward
  // drags/wheel to Claude instead of selecting/scrolling locally — breaking
  // drag-to-copy. Removing these keeps the Claude terminal in normal mouse
  // behavior. Trade-off: mouse CLICKS inside Claude's UI don't register — use
  // the keyboard (arrows/Enter) for its menus. Claude terminal only; the shell
  // is untouched. Preserves ?1049 (alt-screen) and ?25 (cursor).
  // Match any DECSET/DECRST private-mode sequence: ESC [ ? <params> (h|l),
  // where params is a ';'-separated list (apps often combine, e.g.
  // \x1b[?1000;1002;1006h). Remove only the mouse-mode numbers, preserving any
  // non-mouse modes in the same sequence (e.g. 1049 alt-screen, 2004 bracketed
  // paste) so Claude's rendering/paste behavior is untouched.
  const MOUSE_MODES = new Set(['1000', '1001', '1002', '1003', '1005', '1006', '1015']);
  const DEC_PRIVATE_SEQ = /\x1b\[\?([0-9;]+)([hl])/g;
  function stripMouseTracking(data) {
    return data.replace(DEC_PRIVATE_SEQ, (full, params, action) => {
      const kept = params.split(';').filter((p) => !MOUSE_MODES.has(p));
      if (kept.length === params.split(';').length) return full; // no mouse modes → unchanged
      return kept.length ? `\x1b[?${kept.join(';')}${action}` : '';
    });
  }

  // Copy a terminal's selection to the clipboard the instant a drag ends.
  // In a live TUI (Claude) the visible highlight is wiped by the next repaint,
  // so we grab the text on mouseup — a real user gesture, before the repaint —
  // via the focus-independent execCommand path. (We only copy on mouseup, not
  // on every selectionChange, so the hidden-textarea copy can't fight xterm's
  // in-progress selection.)
  // Pairs with macOptionClickForcesSelection (which enables the drag itself).
  function attachSelectionCopy(termInstance, containerEl) {
    if (!containerEl) return;
    containerEl.addEventListener('mouseup', () => {
      if (!termInstance.hasSelection || !termInstance.hasSelection()) return;
      copyTextToClipboard(termInstance.getSelection());
    });
  }

  // --- Terminal setup ---
  function initTerminal() {
    term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: 1.2,
      letterSpacing: 0,
      allowTransparency: false,
      // Hold Option (Mac) while dragging to force a text selection even when
      // Claude's TUI has mouse tracking enabled.
      macOptionClickForcesSelection: true,
      theme: {
        background: '#272822',
        foreground: '#f8f8f2',
        cursor: '#f92672',
        cursorAccent: '#272822',
        selectionBackground: '#49483e',
        black: '#272822',
        red: '#f92672',
        green: '#a6e22e',
        yellow: '#e6db74',
        blue: '#66d9ef',
        magenta: '#ae81ff',
        cyan: '#a1efe4',
        white: '#f8f8f2',
        brightBlack: '#75715e',
        brightRed: '#f92672',
        brightGreen: '#a6e22e',
        brightYellow: '#e6db74',
        brightBlue: '#66d9ef',
        brightMagenta: '#ae81ff',
        brightCyan: '#a1efe4',
        brightWhite: '#f9f8f5',
      },
    });

    fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalEl);
    attachSelectionCopy(term, terminalEl);

    // WebGL addon for sharper rendering — skip on mobile (GPU issues on low-end devices).
    // This check runs once at init. Addons can't be unloaded, so viewport changes after
    // init won't toggle WebGL. Desktop users always get WebGL; mobile always gets canvas.
    if (!isMobile()) {
      try {
        const webglAddon = new WebglAddon.WebglAddon();
        term.loadAddon(webglAddon);
      } catch (e) {
        console.warn('WebGL addon failed, using canvas renderer');
      }
    }

    fitAddon.fit();

    term.attachCustomKeyEventHandler((event) => {
      if (event.key === 'Enter' && event.shiftKey) {
        if (event.type === 'keydown' && activeSessionId) {
          wsSend(JSON.stringify({ type: 'input', data: '\x1b[13;2u' }));
        }
        return false;
      }
      return true;
    });

    term.onData((data) => {
      if (activeSessionId) {
        wsSend(JSON.stringify({ type: 'input', data }));
      }
    });

    const handleResize = debounce(() => {
      if (fitAddon) {
        fitAddon.fit();
        if (activeSessionId) {
          wsSend(JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows,
          }));
        }
      }
    }, 100);

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(terminalEl);

    // Honor user scroll-up (wheel/touch) immediately, even mid-stream.
    attachScrollIntent(terminalEl, releaseClaudeStick);

    // Keep keyboard focus on the terminal so arrow keys reach Claude's
    // interactive menus. Clicking a tab/sidebar/file can move DOM focus away;
    // any pointer press back inside the terminal area must restore it, else
    // Up/Down scroll the page instead of moving the menu selection.
    const refocusTerm = () => { if (activeTabId === 'claude') term.focus(); };
    terminalEl.addEventListener('mousedown', refocusTerm);
    terminalEl.addEventListener('touchstart', refocusTerm, { passive: true });

    // Sticky scroll: track user scroll position.
    // Skip during attach (forced auto-scroll) and when a write-triggered scroll
    // is pending — onScroll fires mid-write when baseY increases before viewport
    // catches up, which would incorrectly set sticky=false.
    term.onScroll(() => {
      if (claudeAttachScroll || claudePendingScroll) return;
      const was = claudeSticky;
      claudeSticky = isNearBottom(term);
      if (was && !claudeSticky) {
        console.debug('[scroll] claude: user scrolled away from bottom');
      }
    });

    // Sticky scroll: scroll after writes are parsed
    term.onWriteParsed(() => {
      if (!claudePendingScroll) return;
      claudePendingScroll = false;
      term.scrollToBottom();
      claudeSticky = true;
    });
  }

  function initShellTerminal() {
    shellTerm = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: 1.2,
      letterSpacing: 0,
      allowTransparency: false,
      // Hold Option (Mac) while dragging to force a text selection even when
      // Claude's TUI has mouse tracking enabled.
      macOptionClickForcesSelection: true,
      theme: {
        background: '#272822',
        foreground: '#f8f8f2',
        cursor: '#f92672',
        cursorAccent: '#272822',
        selectionBackground: '#49483e',
        black: '#272822',
        red: '#f92672',
        green: '#a6e22e',
        yellow: '#e6db74',
        blue: '#66d9ef',
        magenta: '#ae81ff',
        cyan: '#a1efe4',
        white: '#f8f8f2',
        brightBlack: '#75715e',
        brightRed: '#f92672',
        brightGreen: '#a6e22e',
        brightYellow: '#e6db74',
        brightBlue: '#66d9ef',
        brightMagenta: '#ae81ff',
        brightCyan: '#a1efe4',
        brightWhite: '#f9f8f5',
      },
    });

    shellFitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();

    shellTerm.loadAddon(shellFitAddon);
    shellTerm.loadAddon(webLinksAddon);
    shellTerm.open(shellTerminalEl);
    attachSelectionCopy(shellTerm, shellTerminalEl);

    if (!isMobile()) {
      try {
        const webglAddon = new WebglAddon.WebglAddon();
        shellTerm.loadAddon(webglAddon);
      } catch (e) {
        console.warn('Shell WebGL addon failed, using canvas renderer');
      }
    }

    shellFitAddon.fit();

    shellTerm.attachCustomKeyEventHandler((event) => {
      if (event.key === 'Enter' && event.shiftKey) {
        if (event.type === 'keydown' && activeSessionId) {
          wsSend(JSON.stringify({ type: 'shell-input', sessionId: activeSessionId, data: '\x1b[13;2u' }));
        }
        return false;
      }
      return true;
    });

    shellTerm.onData((data) => {
      if (activeSessionId) {
        wsSend(JSON.stringify({ type: 'shell-input', sessionId: activeSessionId, data }));
      }
    });

    const handleShellResize = debounce(() => {
      if (shellFitAddon) {
        shellFitAddon.fit();
        if (activeSessionId) {
          wsSend(JSON.stringify({
            type: 'shell-resize',
            sessionId: activeSessionId,
            cols: shellTerm.cols,
            rows: shellTerm.rows,
          }));
        }
      }
    }, 100);

    const shellResizeObserver = new ResizeObserver(handleShellResize);
    shellResizeObserver.observe(shellTerminalEl);

    // Honor user scroll-up (wheel/touch) immediately, even mid-stream.
    attachScrollIntent(shellTerminalEl, releaseShellStick);

    // Sticky scroll: skip during attach and when write-triggered scroll is pending
    shellTerm.onScroll(() => {
      if (shellAttachScroll || shellPendingScroll) return;
      const was = shellSticky;
      shellSticky = isNearBottom(shellTerm);
      if (was && !shellSticky) {
        console.debug('[scroll] shell: user scrolled away from bottom');
      }
    });

    // Sticky scroll: scroll after writes are parsed
    shellTerm.onWriteParsed(() => {
      if (!shellPendingScroll) return;
      shellPendingScroll = false;
      shellTerm.scrollToBottom();
      shellSticky = true;
    });
  }

  // --- WebSocket ---
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      reconnectDelay = 1000;
      setConnected(true);
      if (activeSessionId) {
        attachSession(activeSessionId);
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'output':
          if (msg.sessionId === activeSessionId && msg.data) {
            // During attach, force scroll on every write until output settles
            if (claudeAttachScroll) {
              claudePendingScroll = true;
              clearTimeout(claudeAttachTimer);
              claudeAttachTimer = setTimeout(() => {
                claudeAttachScroll = false;
                claudeSticky = true;
              }, ATTACH_SETTLE_MS);
            } else if (claudeSticky) {
              claudePendingScroll = true;
            }
            // In Select mode, strip mouse-tracking so the wheel scrolls xterm
            // locally and drag selects/copies. Otherwise pass through so Claude
            // controls the mouse (its own scroll + clickable UI).
            term.write(selectMode ? stripMouseTracking(msg.data) : msg.data);
          }
          break;

        case 'replay-done':
          if (msg.sessionId === activeSessionId) {
            // Scroll after write queue drains. Attach auto-scroll stays active
            // to also cover SIGWINCH re-render output arriving after this.
            term.write('', () => {
              requestAnimationFrame(() => {
                term.scrollToBottom();
                claudeSticky = true;
              });
            });
          }
          break;

        case 'attach-error':
          if (msg.sessionId === activeSessionId) {
            term.reset();
            term.write('\x1b[31m\r\n  Failed to attach to session.\x1b[0m\r\n');
          }
          break;

        case 'state':
          projects = msg.projects;
          sessions = msg.sessions;
          pruneLockedSessions();
          // On the first state after a page load, expand every project so all
          // sessions are visible without manual clicking, and auto-select the
          // session the user was last in (falling back to the most recent one).
          if (!initialStateApplied) {
            initialStateApplied = true;
            for (const proj of projects) expandedProjects.add(proj.id);
            maybeAutoSelectSession().catch(() => {});
          }
          // Reconcile: if active session no longer exists, return to home
          if (activeSessionId && !sessions.find((s) => s.id === activeSessionId)) {
            returnToHome();
          }
          renderSidebar();
          updateMobileTopbar();
          break;

        case 'session-deleted':
          if (msg.sessionId === activeSessionId) {
            returnToHome();
          }
          break;

        case 'exited':
          // Session still exists, just re-render sidebar to update status dot
          renderSidebar();
          updateMobileTopbar();
          break;

        case 'shell-output':
          if (msg.sessionId === activeSessionId && msg.data) {
            if (shellAttachScroll) {
              shellPendingScroll = true;
              clearTimeout(shellAttachTimer);
              shellAttachTimer = setTimeout(() => {
                shellAttachScroll = false;
                shellSticky = true;
              }, ATTACH_SETTLE_MS);
            } else if (shellSticky) {
              shellPendingScroll = true;
            }
            shellTerm.write(msg.data);
          }
          break;

        case 'shell-replay-done':
          if (msg.sessionId === activeSessionId) {
            shellDead = false;
            shellTerm.write('', () => {
              requestAnimationFrame(() => {
                shellTerm.scrollToBottom();
                shellSticky = true;
              });
            });
          }
          break;

        case 'shell-exited':
          // The shell process ended (e.g. user typed `exit`). Mark it dead so
          // the next Terminal-tab view re-attaches (spawns a fresh shell), and
          // show a hint in the frozen pane.
          if (msg.sessionId === activeSessionId) {
            shellDead = true;
            shellTerm.write('\r\n\x1b[2m[shell exited — reopen the Terminal tab to start a new shell]\x1b[0m\r\n');
          }
          break;

        case 'image-upload-ok':
          if (msg.path) {
            navigator.clipboard.writeText(msg.path).then(() => {
              showToast('Image saved — path copied to clipboard', 'success', 4000);
            }).catch(() => {
              showToast('Image saved: ' + msg.path, 'success', 6000);
            });
          }
          break;

        case 'image-upload-error':
          showToast(msg.error || 'Image upload failed', 'error');
          break;
      }
    };

    ws.onclose = () => {
      setConnected(false);
      const jitter = reconnectDelay * (0.5 + Math.random());
      setTimeout(connect, jitter);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };

    ws.onerror = () => { ws.close(); };
  }

  // Reset the UI to the "no active session" home state.
  function returnToHome() {
    activeSessionId = null;
    forgetLastSession();
    term.reset();
    noSession.classList.remove('hidden');
    tabBar.classList.remove('visible');
    shellPane.classList.add('hidden');
    filesPane.classList.add('hidden');
    historyPane.classList.add('hidden');
    fileViewer.classList.add('hidden');
    const tw = document.getElementById('terminal-wrapper');
    tw.style.display = '';
    tw.style.inset = '0';
    updateMobileTopbar();
  }

  // Persist the last-opened session so a page refresh can re-select it.
  const LAST_SESSION_KEY = 'claude-console:lastSessionId';
  function rememberLastSession(id) {
    try { localStorage.setItem(LAST_SESSION_KEY, id); } catch {}
  }
  function forgetLastSession() {
    try { localStorage.removeItem(LAST_SESSION_KEY); } catch {}
  }
  function getLastSession() {
    try { return localStorage.getItem(LAST_SESSION_KEY); } catch { return null; }
  }

  // On first load, re-open the session the user was last in. Prefer the
  // persisted last session; otherwise the most recently created one. Does
  // nothing (keeps the welcome screen) when there are no sessions at all.
  async function maybeAutoSelectSession() {
    if (activeSessionId) return; // already attached (e.g. reconnect)
    if (sessions.length === 0) return; // no sessions → show welcome screen

    // Don't auto-open a session parked in a locked project.
    const selectable = sessions.filter((s) => !lockedSessions.has(s.id));
    if (selectable.length === 0) return;

    const lastId = getLastSession();
    let target = lastId && selectable.find((s) => s.id === lastId);
    if (!target) {
      target = [...selectable].sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      )[0];
    }
    if (!target) return;

    // Expand the parent project so the selection is visible in the sidebar.
    expandedProjects.add(target.projectId);

    if (!target.alive && target.claudeSessionId) {
      attachSession(target.id, { showLoading: true });
      const result = await restartSession(target.id, { suppressModal: true });
      // User switched away while we waited — leave their choice alone.
      if (activeSessionId !== target.id) return;
      if (result === true) {
        attachSession(target.id);
      } else {
        // Restart failed or the conversation is running elsewhere. Don't strand
        // the pane on 'Resuming…' — return to the welcome screen so the user can
        // pick an action deliberately (e.g. click the session to Fork/New).
        returnToHome();
      }
    } else {
      attachSession(target.id);
    }
  }

  function attachSession(sessionId, opts = {}) {
    activeSessionId = sessionId;
    rememberLastSession(sessionId);
    term.reset();
    shellTerm.reset();

    if (opts.showLoading) {
      // Show loading indicator while waiting for restart to complete
      term.write('\x1b[2m\r\n  Resuming session\u2026\x1b[0m');
    }

    // Enter attach auto-scroll mode: force scroll-to-bottom on every write
    // until output settles (covers replay buffer + SIGWINCH re-render)
    claudeAttachScroll = true;
    claudeSticky = true;
    claudePendingScroll = false;
    clearTimeout(claudeAttachTimer);
    shellAttachScroll = true;
    shellSticky = true;
    shellPendingScroll = false;
    shellDead = false;
    clearTimeout(shellAttachTimer);
    noSession.classList.add('hidden');

    // Update the Files pane path for this session
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      rightPanelPath.textContent = session.worktreePath || '';
      rightPanelPath.title = session.worktreePath || '';

      // Reset tabs and file tree for new session
      openTabs = [];
      activeTabId = 'claude';
      browseScope = 'worktree';
      updateScopeToggleLabel();
      switchTab('claude');
      renderTabs();
      initFileTree();
    }

    // In loading-only mode, don't send attach yet (restart hasn't completed)
    if (opts.showLoading) {
      renderSidebar();
      return;
    }

    wsSend(JSON.stringify({
      type: 'attach',
      sessionId,
      cols: term.cols,
      rows: term.rows,
    }));

    // Attach shell terminal
    sendShellAttach();

    // After layout settles, re-fit and send the true width. On a fresh page
    // load / reconnect (e.g. switching from phone to laptop) the cols captured
    // above can be stale/narrow because the terminal hadn't been laid out at the
    // new viewport yet; this forces the PTY to the laptop width so Claude
    // reflows its live UI wide instead of staying at the phone's narrow column.
    requestAnimationFrame(() => {
      if (!fitAddon || activeSessionId !== sessionId) return;
      fitAddon.fit();
      wsSend(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });

    term.focus();
    renderSidebar();
    updateMobileTopbar();
  }

  // (Re)attach the shell for the active session. The server spawns a fresh shell
  // if none is alive, so this doubles as "respawn after the shell exited".
  function sendShellAttach() {
    if (!activeSessionId) return;
    shellDead = false;
    wsSend(JSON.stringify({
      type: 'shell-attach',
      sessionId: activeSessionId,
      cols: shellTerm.cols,
      rows: shellTerm.rows,
    }));
  }

  // --- Sidebar ---
  function renderSidebar() {
    projectListEl.innerHTML = '';

    // Mobile: show flat "Recent" section for quick session switching
    if (isMobile() && sessions.length > 0) {
      const recentSessions = [...sessions]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 5);

      const recentGroup = document.createElement('div');
      recentGroup.className = 'project-group';

      const recentHeader = document.createElement('div');
      recentHeader.className = 'project-header mobile-recent-header';

      const recentName = document.createElement('span');
      recentName.className = 'project-name mobile-recent-label';
      recentName.textContent = 'Recent';
      recentHeader.appendChild(recentName);
      recentGroup.appendChild(recentHeader);

      const recentUl = document.createElement('ul');
      recentUl.className = 'project-sessions expanded';

      for (const s of recentSessions) {
        const li = document.createElement('li');
        if (s.id === activeSessionId) li.classList.add('active');

        const dot = document.createElement('span');
        dot.className = 'status-dot ' + (s.alive ? 'alive' : 'exited');

        const sName = document.createElement('span');
        sName.className = 'session-name';
        sName.textContent = s.name;

        li.appendChild(dot);
        li.appendChild(sName);
        li.onclick = () => {
          if (lockedSessions.has(s.id)) return; // locked session → inert
          if (!s.alive && s.claudeSessionId) {
            restartSession(s.id);
          }
          attachSession(s.id);
          closeMobileSidebar();
        };
        recentUl.appendChild(li);
      }

      recentGroup.appendChild(recentUl);
      projectListEl.appendChild(recentGroup);
    }

    // Sort projects by createdAt ascending (design spec)
    const sortedProjects = [...projects].sort((a, b) =>
      new Date(a.createdAt) - new Date(b.createdAt));

    for (const proj of sortedProjects) {
      const group = document.createElement('div');
      group.className = 'project-group';
      group.dataset.projectId = proj.id;

      // Project header
      const header = document.createElement('div');
      header.className = 'project-header';

      const arrow = document.createElement('span');
      arrow.className = 'project-arrow';
      if (expandedProjects.has(proj.id)) arrow.classList.add('expanded');
      arrow.textContent = '\u25B6';

      const name = document.createElement('span');
      name.className = 'project-name';
      name.textContent = proj.name;

      // New-session button (beside the project row)
      const newSessBtn = document.createElement('button');
      newSessBtn.className = 'project-new-session';
      newSessBtn.textContent = '+';
      newSessBtn.title = 'New session';
      newSessBtn.onclick = (e) => {
        e.stopPropagation();
        expandedProjects.add(proj.id);
        renderSidebar();
        // After re-render, open the inline input on this project's list
        requestAnimationFrame(() => {
          const projGroup = projectListEl.querySelector(`[data-project-id="${proj.id}"]`);
          const ul = projGroup && projGroup.querySelector('.project-sessions');
          if (ul) showInlineSessionInput(ul, proj.id);
        });
      };

      const del = document.createElement('button');
      del.className = 'project-delete';
      del.textContent = '\u00D7';
      del.title = 'Delete project';
      del.onclick = (e) => {
        e.stopPropagation();
        showConfirmDialog(
          'Close Project',
          `Close "${proj.name}" and all its sessions?`,
          () => deleteProject(proj.id),
          null,
          'Close Project'
        );
      };

      header.appendChild(arrow);
      header.appendChild(name);
      header.appendChild(newSessBtn);
      header.appendChild(del);

      header.onclick = () => {
        if (expandedProjects.has(proj.id)) {
          expandedProjects.delete(proj.id);
        } else {
          expandedProjects.add(proj.id);
        }
        renderSidebar();
      };

      group.appendChild(header);

      // Sessions list
      const projSessions = sessions
        .filter((s) => s.projectId === proj.id)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      const ul = document.createElement('ul');
      ul.className = 'project-sessions';
      if (expandedProjects.has(proj.id)) ul.classList.add('expanded');

      for (const s of projSessions) {
        const sessionLocked = lockedSessions.has(s.id);
        const li = document.createElement('li');
        if (s.id === activeSessionId) li.classList.add('active');
        if (sessionLocked) li.classList.add('locked');

        const dot = document.createElement('span');
        dot.className = 'status-dot';
        dot.classList.add(s.alive ? 'alive' : 'exited');

        // Session info container (name + optional branch badge)
        const infoContainer = document.createElement('div');
        infoContainer.className = 'session-info';

        const sName = document.createElement('span');
        sName.className = 'session-name';
        sName.textContent = s.name;
        infoContainer.appendChild(sName);

        // Branch badge (if session has worktree)
        if (s.branchName) {
          const branchBadge = document.createElement('span');
          branchBadge.className = 'branch-badge';
          branchBadge.textContent = s.branchName;
          branchBadge.title = s.worktreePath || s.branchName;
          infoContainer.appendChild(branchBadge);
        }

        const time = document.createElement('span');
        time.className = 'session-time';
        time.textContent = relativeTime(s.createdAt);

        // Session actions container
        const actions = document.createElement('div');
        actions.className = 'session-actions';

        // Lock (eye) action — a locked session stays visible but inert (no
        // hover/click/select), like locking a track. Thin monochrome glyph to
        // match the × (close) and ⤓ (merge) icons. Persisted per session.
        const sLock = document.createElement('button');
        sLock.className = 'session-lock' + (sessionLocked ? ' locked' : '');
        sLock.textContent = sessionLocked ? '⊘' : '◎'; // ⊘ locked / ◎ open
        sLock.title = sessionLocked
          ? 'Session locked — click to unlock'
          : 'Lock session — keep visible but non-interactive';
        sLock.onclick = (e) => {
          e.stopPropagation();
          if (lockedSessions.has(s.id)) lockedSessions.delete(s.id);
          else lockedSessions.add(s.id);
          saveLockedSessions();
          renderSidebar();
        };
        actions.appendChild(sLock);

        // Merge-to-local action (only for sessions with a worktree branch)
        if (s.branchName) {
          const sMerge = document.createElement('button');
          sMerge.className = 'session-merge';
          sMerge.textContent = '\u2913'; // \u2913 down-to-bar: "bring changes down to local"
          sMerge.title = 'Merge this session\u2019s changes into your local branch';
          sMerge.onclick = (e) => {
            e.stopPropagation();
            showConfirmDialog(
              'Merge to Local',
              `Merge "${s.name}" into your local branch? Uncommitted work in the session is auto-committed first.`,
              () => mergeSession(s.id),
              null,
              'Merge'
            );
          };
          actions.appendChild(sMerge);
        }

        const sDel = document.createElement('button');
        sDel.className = 'session-delete';
        sDel.textContent = '\u00D7';
        sDel.title = 'Close session';
        sDel.onclick = (e) => {
          e.stopPropagation();
          showConfirmDialog(
            'Close Session',
            `Close "${s.name}"?`,
            () => deleteSession(s.id),
            null,
            'Close Session'
          );
        };
        actions.appendChild(sDel);

        li.appendChild(dot);
        li.appendChild(infoContainer);
        li.appendChild(time);
        li.appendChild(actions);

        li.onclick = async () => {
          // Locked session: inert (but the lock button itself still works).
          if (lockedSessions.has(s.id)) return;
          // Guard against rapid clicking: ignore if already switching to this session
          if (activeSessionId === s.id && s.alive) return;

          if (!s.alive && s.claudeSessionId) {
            // Show loading state immediately while restart is in progress
            attachSession(s.id, { showLoading: true });
            const ok = await restartSession(s.id);
            // Guard: user may have switched to a different session while waiting
            if (!ok || activeSessionId !== s.id) return;
            attachSession(s.id);
          } else {
            attachSession(s.id);
          }
          closeMobileSidebar();
        };

        ul.appendChild(li);
      }

      group.appendChild(ul);
      projectListEl.appendChild(group);
    }
  }

  function showInlineSessionInput(ul, projectId) {
    // Remove any existing inline input
    const existing = ul.querySelector('.inline-session-input');
    if (existing) { existing.remove(); return; }

    const input = document.createElement('input');
    input.className = 'inline-session-input';
    input.type = 'text';
    input.placeholder = 'Session name...';
    ul.appendChild(input);
    input.focus();

    input.onkeydown = async (e) => {
      if (e.key === 'Enter') {
        const name = input.value.trim();
        if (!name) return;
        input.disabled = true;
        await createSession(projectId, name);
        input.remove();
      } else if (e.key === 'Escape') {
        input.remove();
      }
    };

    input.onblur = () => {
      setTimeout(() => input.remove(), 150);
    };
  }

  // --- API calls ---
  async function createProject(name, cwd) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cwd }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to create project');
      return null;
    }
    return await res.json();
  }

  async function deleteProject(id, force = false) {
    const url = force ? `/api/projects/${id}?force=true` : `/api/projects/${id}`;
    const res = await fetch(url, { method: 'DELETE' });
    if (res.ok) return;

    const err = await res.json().catch(() => ({}));
    if (err.code === 'DIRTY_WORKTREE') {
      // Server refused because a session has uncommitted changes. Offer a
      // forced retry (mirrors deleteSession's dirty-worktree flow).
      const names = Array.isArray(err.sessions) && err.sessions.length
        ? ` (${err.sessions.join(', ')})` : '';
      showConfirmDialog(
        'Uncommitted Changes',
        `Some sessions have uncommitted changes${names} that will be permanently lost. Close the project anyway?`,
        () => deleteProject(id, true),
        null,
        'Discard & Close'
      );
      return;
    }
    showToast(err.error || 'Failed to close project', 'error');
  }

  // Drop lock entries for sessions that no longer exist (deleted via any path)
  // so the persisted set doesn't grow unbounded. Called on each state update.
  function pruneLockedSessions() {
    if (lockedSessions.size === 0) return;
    const live = new Set(sessions.map((s) => s.id));
    let changed = false;
    for (const id of [...lockedSessions]) {
      if (!live.has(id)) { lockedSessions.delete(id); changed = true; }
    }
    if (changed) saveLockedSessions();
  }

  async function createSession(projectId, name) {
    const res = await fetch(`/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json();
      // Handle specific error codes
      let errorMessage = err.error || 'Failed to create session';
      if (err.code === 'WORKTREE_FAILED') {
        errorMessage = 'Failed to create worktree: ' + (err.error || 'Unknown error');
      }
      // Show error inline in sidebar near the project's session list
      const projGroup = projectListEl.querySelector(`[data-project-id="${projectId}"]`);
      if (projGroup) {
        const errEl = document.createElement('div');
        errEl.className = 'inline-error';
        errEl.textContent = errorMessage;
        projGroup.appendChild(errEl);
        setTimeout(() => errEl.remove(), 4000);
      }
      return null;
    }
    const session = await res.json();

    // Show warning toast if .worktrees not in .gitignore
    if (session.warning) {
      showToast(session.warning, 'warning', 6000);
    }

    attachSession(session.id);
    return session;
  }

  async function deleteSession(id, force = false) {
    const url = force ? `/api/sessions/${id}?force=true` : `/api/sessions/${id}`;
    const res = await fetch(url, { method: 'DELETE' });

    if (!res.ok) {
      const err = await res.json();
      if (err.code === 'DIRTY_WORKTREE') {
        // Second confirmation: closing would discard uncommitted git changes.
        showConfirmDialog(
          'Uncommitted Changes',
          'This session has uncommitted changes that will be permanently lost. Close anyway?',
          () => deleteSession(id, true), // Retry with force
          null,
          'Discard & Close'
        );
        return;
      }
      if (err.code === 'DIRTY_CHECK_FAILED') {
        showConfirmDialog(
          'Cannot Verify',
          'Unable to verify whether this session has uncommitted changes. Close anyway?',
          () => deleteSession(id, true),
          null,
          'Close Anyway'
        );
        return;
      }
      // Show other errors as toast
      showToast(err.error || 'Failed to close session', 'error');
      return;
    }

    if (activeSessionId === id) {
      returnToHome();
    }
  }

  async function mergeSession(id) {
    showToast('Merging to local…', 'info', 2000);
    let res, data;
    try {
      res = await fetch(`/api/sessions/${id}/merge`, { method: 'POST' });
      data = await res.json();
    } catch {
      showToast('Merge request failed', 'error');
      return;
    }
    if (!res.ok) {
      // Conflicts / dirty main / etc. — show the actionable server message.
      showToast(data.error || 'Merge failed', 'error', 7000);
      return;
    }
    showToast(data.message || 'Merged to local.', 'success', 6000);
  }

  async function restartSession(id, { fork = false, suppressModal = false } = {}) {
    const url = fork
      ? `/api/sessions/${id}/restart?fork=true`
      : `/api/sessions/${id}/restart`;
    const res = await fetch(url, { method: 'POST' });

    if (!res.ok) {
      const err = await res.json();
      if (err.code === 'WORKTREE_MISSING') {
        if (!suppressModal) showToast('Worktree has been removed. Session cannot be restarted.', 'error');
      } else if (err.code === 'SESSION_RUNNING_ELSEWHERE') {
        // Suppressed during unprompted auto-select-on-load: don't pop a modal
        // the user didn't ask for. Signal the caller to handle it quietly.
        if (suppressModal) return 'running_elsewhere';
        // The conversation is live as a background agent — offer to fork a copy.
        // A separate "New Session" button starts a fresh session in the same
        // project so the user can /resume themselves. Cancel just dismisses.
        const orig = sessions.find((s) => s.id === id);
        showConfirmDialog(
          'Session Running Elsewhere',
          'This conversation is already running as a background agent, so it can’t be resumed here directly. Fork a copy to continue in the console, or start a new session where you can /resume yourself.',
          async () => {
            const ok = await restartSession(id, { fork: true });
            if (ok) attachSession(id);
          },
          null,
          'Fork',
          {
            label: 'New',
            onClick: () => {
              if (orig) createSession(orig.projectId, `${orig.name} (resume)`);
            },
          }
        );
      } else {
        showToast(err.error || 'Failed to restart session', 'error');
      }
      return false;
    }
    return true;
  }

  // --- Directory Browser ---
  let browsePath = '';
  let homedir = ''; // learned from first /api/browse response

  async function loadDir(dirPath) {
    const url = dirPath
      ? `/api/browse?path=${encodeURIComponent(dirPath)}`
      : '/api/browse';
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    browsePath = data.path;

    // Learn homedir from default browse (no path param)
    if (!homedir) homedir = data.path;

    // Render breadcrumbs relative to homedir
    dirBreadcrumbs.innerHTML = '';

    // ~ crumb (always clickable, navigates to homedir)
    const homeSpan = document.createElement('span');
    homeSpan.className = 'breadcrumb';
    homeSpan.textContent = '~';
    homeSpan.onclick = () => loadDir('');
    dirBreadcrumbs.appendChild(homeSpan);

    // Only show segments after the homedir prefix
    const relativePath = data.path.startsWith(homedir)
      ? data.path.slice(homedir.length)
      : data.path;
    const segments = relativePath.split('/').filter(Boolean);

    let accumulated = homedir;
    for (const seg of segments) {
      accumulated += '/' + seg;
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '/';
      dirBreadcrumbs.appendChild(sep);

      const crumb = document.createElement('span');
      crumb.className = 'breadcrumb';
      crumb.textContent = seg;
      const pathForClick = accumulated;
      crumb.onclick = () => loadDir(pathForClick);
      dirBreadcrumbs.appendChild(crumb);
    }

    // Render directory list
    dirList.innerHTML = '';

    // Parent directory entry (only if we're deeper than homedir)
    if (data.parent && data.path !== homedir) {
      const parentLi = document.createElement('li');
      parentLi.textContent = '..';
      parentLi.onclick = () => loadDir(data.parent);
      dirList.appendChild(parentLi);
    }

    for (const d of data.dirs) {
      const li = document.createElement('li');
      li.textContent = d;
      li.onclick = () => loadDir(data.path + '/' + d);
      dirList.appendChild(li);
    }
  }

  // --- Modal ---
  function openModal() {
    modalProjectName.value = '';
    modalProjectPath.value = '';
    dirBrowser.classList.add('hidden');
    btnModalCreate.disabled = true;
    modalOverlay.classList.remove('hidden');
    modalProjectName.focus();
  }

  function closeModal() {
    modalOverlay.classList.add('hidden');
  }

  function updateCreateButton() {
    btnModalCreate.disabled = !(modalProjectName.value.trim() && modalProjectPath.value.trim());
  }

  btnAddProject.onclick = openModal;
  btnHomeAddProject.onclick = openModal;

  btnBrowse.onclick = () => {
    if (dirBrowser.classList.contains('hidden')) {
      dirBrowser.classList.remove('hidden');
      loadDir('');
    } else {
      dirBrowser.classList.add('hidden');
    }
  };

  btnSelectDir.onclick = () => {
    modalProjectPath.value = browsePath;
    dirBrowser.classList.add('hidden');
    updateCreateButton();
  };

  btnModalCancel.onclick = closeModal;

  btnModalCreate.onclick = async () => {
    const name = modalProjectName.value.trim();
    const cwd = modalProjectPath.value.trim();
    if (!name || !cwd) return;
    btnModalCreate.disabled = true;
    const proj = await createProject(name, cwd);
    if (proj) {
      expandedProjects.add(proj.id);
      closeModal();
    }
    updateCreateButton();
  };

  modalProjectName.oninput = updateCreateButton;

  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };

  document.onkeydown = (e) => {
    if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
      closeModal();
    }
  };

  // --- File Tree ---

  async function fetchDirEntries(relativePath) {
    if (!activeSessionId) return { dirs: [], files: [], hasMore: false };
    const params = new URLSearchParams({ sessionId: activeSessionId });
    if (relativePath) params.set('path', relativePath);
    if (browseScope === 'project') params.set('scope', 'project');
    const res = await fetch(`/api/browse?${params}`);
    if (!res.ok) return { dirs: [], files: [], hasMore: false };
    const data = await res.json();
    return {
      dirs: data.dirs || [],
      files: data.files || [],
      hasMore: data.hasMore || false,
    };
  }

  async function renderFileTreeDir(container, relativePath, depth) {
    container.innerHTML = '';

    const loading = document.createElement('div');
    loading.className = 'file-tree-loading';
    loading.textContent = 'Loading\u2026';
    container.appendChild(loading);

    const { dirs, files, hasMore } = await fetchDirEntries(relativePath);
    container.innerHTML = '';

    const indent = depth * 16;

    // Render directories first
    for (const dir of dirs) {
      const dirPath = relativePath ? relativePath + '/' + dir : dir;
      const item = document.createElement('div');

      const row = document.createElement('div');
      row.className = 'file-tree-item file-tree-folder';
      row.style.paddingLeft = indent + 'px';

      const arrow = document.createElement('span');
      arrow.className = 'file-tree-arrow';
      arrow.textContent = expandedDirs.has(dirPath) ? '\u25BC' : '\u25B6';

      const label = document.createElement('span');
      label.className = 'file-tree-label';
      label.textContent = dir;

      row.appendChild(arrow);
      row.appendChild(label);

      const children = document.createElement('div');
      children.className = 'file-tree-children';
      if (expandedDirs.has(dirPath)) {
        children.classList.add('expanded');
        renderFileTreeDir(children, dirPath, depth + 1);
      }

      row.onclick = () => {
        if (expandedDirs.has(dirPath)) {
          expandedDirs.delete(dirPath);
          arrow.textContent = '\u25B6';
          children.classList.remove('expanded');
          children.innerHTML = '';
        } else {
          expandedDirs.add(dirPath);
          arrow.textContent = '\u25BC';
          children.classList.add('expanded');
          renderFileTreeDir(children, dirPath, depth + 1);
        }
      };

      item.appendChild(row);
      item.appendChild(children);
      container.appendChild(item);
    }

    // Render files
    for (const file of files) {
      const filePath = relativePath ? relativePath + '/' + file : file;

      const row = document.createElement('div');
      row.className = 'file-tree-item';
      row.style.paddingLeft = (indent + 16) + 'px';

      const label = document.createElement('span');
      label.className = 'file-tree-label';
      label.textContent = file;
      label.title = filePath;

      row.appendChild(label);
      row.onclick = () => openFileTab(filePath, file);
      container.appendChild(row);
    }

    // "Show more" indicator when entries were truncated
    if (hasMore) {
      const more = document.createElement('div');
      more.className = 'file-tree-more';
      more.style.paddingLeft = indent + 'px';
      more.textContent = 'More entries not shown\u2026';
      container.appendChild(more);
    }

    // Show message if empty
    if (dirs.length === 0 && files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'file-tree-loading';
      empty.textContent = 'Empty directory';
      container.appendChild(empty);
    }
  }

  function initFileTree() {
    if (!activeSessionId) {
      fileTreeEl.innerHTML = '';
      return;
    }
    expandedDirs.clear();
    renderFileTreeDir(fileTreeEl, '', 0);
  }

  // Files scope toggle (worktree <-> project root)
  function updateScopeToggleLabel() {
    if (!filesScopeToggle) return;
    const inProject = browseScope === 'project';
    filesScopeToggle.textContent = inProject ? 'Session worktree' : 'Project root';
    filesScopeToggle.classList.toggle('active', inProject);
    filesScopeToggle.title = inProject
      ? 'Currently browsing the whole project. Click to return to this session’s worktree.'
      : 'Currently browsing this session’s worktree. Click to browse the whole project root.';
  }
  if (filesScopeToggle) {
    filesScopeToggle.onclick = () => {
      browseScope = browseScope === 'project' ? 'worktree' : 'project';
      updateScopeToggleLabel();
      initFileTree();
    };
  }

  // --- Conversation history (transcript) ---

  async function loadHistory() {
    if (!activeSessionId) return;
    // Capture the session this load is for; if the user switches sessions before
    // the fetch resolves, discard the stale response instead of rendering it
    // into the wrong session's History view.
    const sid = activeSessionId;
    historyStatus.textContent = 'Loading…';
    historyContent.innerHTML = '';
    let data;
    try {
      const res = await fetch(`/api/history?sessionId=${sid}`);
      data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load history');
    } catch (e) {
      if (activeSessionId !== sid) return;
      historyStatus.textContent = '';
      const err = document.createElement('div');
      err.className = 'hist-empty';
      err.textContent = e.message || 'Failed to load history';
      historyContent.appendChild(err);
      return;
    }
    if (activeSessionId !== sid) return; // session changed mid-flight
    renderHistory(data);
  }

  function renderHistory(data) {
    historyContent.innerHTML = '';
    const turns = data.turns || [];
    historyStatus.textContent = turns.length ? `${turns.length} messages` : '';

    if (turns.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hist-empty';
      empty.textContent = data.note || 'No conversation history yet.';
      historyContent.appendChild(empty);
      return;
    }

    for (const turn of turns) {
      const el = document.createElement('div');
      el.className = 'hist-turn ' + (turn.role === 'user' ? 'user' : 'assistant');

      const roleEl = document.createElement('div');
      roleEl.className = 'hist-role';
      roleEl.textContent = turn.role === 'user' ? 'You' : 'Claude';
      el.appendChild(roleEl);

      const body = document.createElement('div');
      body.className = 'hist-body';

      for (const part of turn.parts) {
        if (part.kind === 'text') {
          const block = document.createElement('div');
          renderMarkdownInto(block, part.text);
          body.appendChild(block);
        } else if (part.kind === 'thinking') {
          const t = document.createElement('div');
          t.className = 'hist-thinking';
          t.textContent = part.text;
          body.appendChild(t);
        } else if (part.kind === 'tool_use') {
          const tool = document.createElement('div');
          tool.className = 'hist-tool';
          const name = document.createElement('span');
          name.className = 'hist-tool-name';
          name.textContent = `⚙ ${part.name}`;
          tool.appendChild(name);
          if (part.input && Object.keys(part.input).length) {
            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(part.input, null, 2);
            tool.appendChild(pre);
          }
          body.appendChild(tool);
        } else if (part.kind === 'tool_result') {
          if (!part.text || !part.text.trim()) continue;
          const tool = document.createElement('div');
          tool.className = 'hist-tool' + (part.isError ? ' error' : '');
          const name = document.createElement('span');
          name.className = 'hist-tool-name';
          name.textContent = part.isError ? '⚠ tool result' : '← tool result';
          tool.appendChild(name);
          const pre = document.createElement('pre');
          // Cap very long tool outputs so the transcript stays scrollable.
          pre.textContent = part.text.length > 4000
            ? part.text.slice(0, 4000) + '\n… (truncated)'
            : part.text;
          tool.appendChild(pre);
          body.appendChild(tool);
        }
      }

      el.appendChild(body);
      historyContent.appendChild(el);
    }
  }

  if (historyRefresh) historyRefresh.onclick = () => loadHistory();

  // --- Tab System ---

  function renderTabs() {
    if (!activeSessionId) {
      tabBar.classList.remove('visible');
      return;
    }
    tabBar.classList.add('visible');
    tabList.innerHTML = '';

    // Fixed tabs (always present, never closeable)
    for (const fixed of FIXED_TABS) {
      const el = document.createElement('div');
      el.className = 'tab' + (activeTabId === fixed.id ? ' active' : '');
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = fixed.label;
      el.appendChild(label);
      el.onclick = () => switchTab(fixed.id);
      tabList.appendChild(el);
    }

    // File tabs
    for (const tab of openTabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (activeTabId === tab.id ? ' active' : '');
      el.title = tab.fullPath;

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = tab.filename;

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '\u00D7';
      close.onclick = (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      };

      el.appendChild(label);
      el.appendChild(close);
      el.onclick = () => switchTab(tab.id);
      tabList.appendChild(el);
    }

    // Select-mode toggle, pinned to the end of the tab bar. ON = mouse capture
    // stripped (fast wheel scroll + drag-to-copy); OFF = Claude controls the
    // mouse (its own scroll + clickable UI).
    const selBtn = document.createElement('button');
    selBtn.id = 'select-mode-toggle';
    selBtn.className = 'select-mode-toggle' + (selectMode ? ' active' : '');
    selBtn.textContent = selectMode ? 'Select: On' : 'Select: Off';
    selBtn.title = selectMode
      ? 'Select mode ON — wheel scrolls and drag copies. Click to let Claude use the mouse.'
      : 'Select mode OFF — Claude controls the mouse. Click to enable scroll/copy.';
    selBtn.onclick = (e) => {
      e.stopPropagation();
      setSelectMode(!selectMode);
    };
    tabList.appendChild(selBtn);
  }

  // Flip Select mode and re-sync the Claude terminal's mouse behavior. Toggling
  // OFF→ON can't retroactively strip an enable Claude already sent, so we also
  // tell xterm to drop mouse mode immediately by resetting; a SIGWINCH-style
  // resize nudge makes Claude re-emit its current modes so state converges.
  function setSelectMode(on) {
    selectMode = on;
    renderTabs();
    // Turning ON: xterm may ALREADY be in mouse mode from an enable Claude sent
    // before stripping began; stripping only blocks FUTURE enables. So actively
    // write the DECRST disable sequences to xterm now to leave mouse mode
    // immediately (from here stripMouseTracking blocks re-enables).
    if (on && term) {
      // Disable every mouse-tracking mode we also strip (1000–1006, 1015).
      term.write('\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l');
    }
    // Nudge Claude to repaint/re-emit control modes so the change takes effect
    // on the current screen (when OFF this restores its mouse enables).
    if (activeSessionId && term) {
      wsSend(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
    if (activeTabId === 'claude') term.focus();
  }

  function switchTab(tabId) {
    activeTabId = tabId;
    renderTabs();

    const termWrapper = document.getElementById('terminal-wrapper');

    // Hide every view; the active branch below reveals exactly one.
    termWrapper.style.display = 'none';
    shellPane.classList.add('hidden');
    filesPane.classList.add('hidden');
    historyPane.classList.add('hidden');
    fileViewer.classList.add('hidden');

    if (tabId === 'claude') {
      termWrapper.style.display = '';
      termWrapper.style.inset = '32px 0 0 0';
      term.focus();
      requestAnimationFrame(() => { if (fitAddon) fitAddon.fit(); });
    } else if (tabId === 'history') {
      historyPane.classList.remove('hidden');
      loadHistory();
    } else if (tabId === 'terminal') {
      shellPane.classList.remove('hidden');
      // If the shell exited (e.g. user typed `exit`), re-attach to spawn a fresh
      // one now that the user is looking at the Terminal again.
      if (shellDead) {
        shellTerm.reset();
        sendShellAttach();
      }
      // xterm can't measure while hidden; fit + focus once visible.
      requestAnimationFrame(() => {
        if (shellFitAddon) shellFitAddon.fit();
        shellTerm.focus();
      });
    } else if (tabId === 'files') {
      filesPane.classList.remove('hidden');
    } else {
      // Opened-file viewer tab
      fileViewer.classList.remove('hidden');
      const tab = openTabs.find(t => t.id === tabId);
      if (tab) {
        renderFileContent(tab);
      }
    }
  }

  function closeTab(tabId) {
    openTabs = openTabs.filter(t => t.id !== tabId);
    if (activeTabId === tabId) {
      // Prefer another open file tab; otherwise return to Files (where file tabs
      // are opened from) rather than jumping back to the Claude terminal.
      activeTabId = openTabs.length > 0 ? openTabs[openTabs.length - 1].id : 'files';
    }
    switchTab(activeTabId);
  }

  async function openFileTab(filePath, filename) {
    const scope = browseScope;
    // Tab id is scoped so the same relative path in the worktree vs project root
    // opens as distinct tabs rather than colliding.
    const tabId = `${scope}:${filePath}`;

    // Check if already open
    const existing = openTabs.find(t => t.id === tabId);
    if (existing) {
      switchTab(existing.id);
      return;
    }

    // Fetch file content
    const scopeParam = scope === 'project' ? '&scope=project' : '';
    const res = await fetch(`/api/file?sessionId=${activeSessionId}&path=${encodeURIComponent(filePath)}${scopeParam}`);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to load file' }));
      showToast(err.error || 'Failed to load file', 'error');
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    let tab;

    if (contentType.includes('application/json')) {
      // Binary file response
      const data = await res.json();
      if (data.isBinary) {
        tab = { id: tabId, filename, fullPath: filePath, scope, content: null, type: 'binary' };
      }
    } else {
      const content = await res.text();
      const ext = filename.split('.').pop().toLowerCase();
      const type = (ext === 'md' || ext === 'markdown') ? 'markdown' : 'text';
      tab = { id: tabId, filename, fullPath: filePath, scope, content, type };
    }

    if (tab) {
      openTabs.push(tab);
      switchTab(tab.id);
    }
  }

  // Render markdown text into an element via the shared parse+sanitize pipeline.
  function renderMarkdownInto(el, text) {
    el.className = 'markdown-body';
    el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  }

  function renderFileContent(tab) {
    fileViewerPath.textContent = tab.fullPath;
    fileViewerContent.innerHTML = '';
    fileViewerContent.className = '';

    if (tab.type === 'binary') {
      fileViewerContent.className = 'binary-file';
      fileViewerContent.textContent = 'Binary file \u2014 not supported';
      return;
    }

    if (tab.type === 'markdown') {
      renderMarkdownInto(fileViewerContent, tab.content);
      return;
    }

    // Plain text
    fileViewerContent.className = 'plain-text';
    fileViewerContent.textContent = tab.content;
  }

  // Refresh button handler
  fileViewerRefresh.onclick = async () => {
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || tab.type === 'binary') return;

    const scopeParam = tab.scope === 'project' ? '&scope=project' : '';
    const res = await fetch(`/api/file?sessionId=${activeSessionId}&path=${encodeURIComponent(tab.fullPath)}${scopeParam}`);
    if (!res.ok) {
      showToast('Failed to refresh file', 'error');
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (data.isBinary) {
        tab.type = 'binary';
        tab.content = null;
      }
    } else {
      tab.content = await res.text();
    }

    renderFileContent(tab);
  };

  // Keyboard shortcuts (only when terminal is NOT focused)
  document.addEventListener('keydown', (e) => {
    const inTerminal = terminalEl.contains(document.activeElement) ||
                       shellTerminalEl.contains(document.activeElement);
    if (inTerminal) return;

    if (e.altKey && e.key === 'Tab') {
      e.preventDefault();
      const allIds = [...FIXED_TAB_IDS, ...openTabs.map(t => t.id)];
      const idx = allIds.indexOf(activeTabId);
      const nextIdx = (idx + 1) % allIds.length;
      switchTab(allIds[nextIdx]);
    }

    if (e.altKey && e.key === 'w') {
      e.preventDefault();
      // Only opened-file tabs are closeable (not the fixed tabs)
      if (!FIXED_TAB_IDS.includes(activeTabId)) {
        closeTab(activeTabId);
      }
    }
  });

  // --- Clipboard Image Paste ---

  document.addEventListener('paste', (e) => {
    if (!activeSessionId) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItem = Array.from(items).find(i => i.type.startsWith('image/'));
    if (imageItem) {
      e.preventDefault();
      e.stopPropagation();

      const blob = imageItem.getAsFile();
      if (!blob) return;

      showToast('Uploading image...', 'info', 2000);

      const reader = new FileReader();
      reader.onload = () => {
        const b64 = reader.result.split(',')[1]; // strip data:image/...;base64, prefix
        wsSend(JSON.stringify({ type: 'image-upload', sessionId: activeSessionId, data: b64 }));
      };
      reader.onerror = () => {
        showToast('Failed to read image from clipboard', 'error');
      };
      reader.readAsDataURL(blob);
      return;
    }

    // Text paste is handled by a capture-phase listener on the terminal element
    // (below) so it can preempt xterm; nothing to do here.
  });

  // Multi-line text paste into the Claude terminal. xterm converts every newline
  // in a paste to \r (Enter) and only wraps it in bracketed-paste markers when
  // the app has that mode ON; if Claude's prompt doesn't have bracketed paste
  // active at paste time, the newlines submit the prompt line-by-line. When the
  // mode is OFF and the text is multi-line, wrap it in \x1b[200~…\x1b[201~
  // ourselves (Claude decodes that as one literal block).
  //
  // MUST be capture-phase on the terminal element: xterm binds its own paste
  // listener on the inner textarea (target phase), so a document/bubble-phase
  // handler runs too late to preempt it (xterm would already have sent the raw
  // newlines). Capture on the ancestor fires first; stopPropagation prevents
  // xterm's listener from also handling it (no double-send).
  terminalEl.addEventListener('paste', (e) => {
    if (!activeSessionId || activeTabId !== 'claude' || !term) return;
    // Images are handled by the document-level handler above.
    if (e.clipboardData && Array.from(e.clipboardData.items || [])
      .some((i) => i.type.startsWith('image/'))) return;
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (!text || !text.includes('\n')) return; // single-line paste is harmless
    if (term.modes && term.modes.bracketedPasteMode) return; // xterm wraps it correctly
    e.preventDefault();
    e.stopPropagation();
    const normalized = text.replace(/\r\n/g, '\n');
    wsSend(JSON.stringify({ type: 'input', data: `\x1b[200~${normalized}\x1b[201~` }));
  }, { capture: true });

  // --- Mobile event listeners ---
  mobileHamburger.addEventListener('click', () => {
    if (sidebarEl.classList.contains('open')) {
      closeMobileSidebar();
    } else {
      openMobileSidebar();
    }
  });

  mobileSessionInfo.addEventListener('click', () => {
    openMobileSidebar();
  });

  sidebarBackdrop.addEventListener('click', () => {
    closeMobileSidebar();
  });

  // Reset sidebar state when crossing breakpoint (e.g. rotating tablet)
  mobileQuery.addEventListener('change', (e) => {
    if (!e.matches) {
      closeMobileSidebar();
    }
  });

  mobileNewSession.addEventListener('click', () => {
    if (!activeSessionId) return;
    const session = sessions.find(s => s.id === activeSessionId);
    if (!session) return;
    // Open sidebar and trigger inline input on the active project
    openMobileSidebar();
    expandedProjects.add(session.projectId);
    renderSidebar();
    requestAnimationFrame(() => {
      const projGroup = projectListEl.querySelector(`[data-project-id="${session.projectId}"]`);
      if (projGroup) {
        const ul = projGroup.querySelector('.project-sessions');
        if (ul) showInlineSessionInput(ul, session.projectId);
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebarEl.classList.contains('open')) {
      closeMobileSidebar();
    }
  });

  // --- Init ---
  updateScopeToggleLabel();
  initTerminal();
  initShellTerminal();
  connect();
})();
