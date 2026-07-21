// UI Smoke test for file viewer feature
// Run: npm run test:smoke
// Requires: playwright (devDependency)
//
// Uses testMode server (in-memory DB, bash shell) with a temp git repo.
// Creates its own fixtures and cleans up after.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { createServer } from '../server.js';

const gitEnv = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

let tempDir, server, browser, page;
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`  \u2705 ${name}`);
    passed++;
  } else {
    console.log(`  \u274c ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-'));
  execSync('git init && git commit --allow-empty -m "init"', {
    cwd: dir,
    env: { ...process.env, ...gitEnv },
  });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Smoke Test\n\nThis is a test file.');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("hello");');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export default 42;');
  execSync('git add -A && git commit -m "add test files"', {
    cwd: dir,
    env: { ...process.env, ...gitEnv },
  });
  return dir;
}

try {
  // Setup
  tempDir = createTempRepo();
  server = createServer({ testMode: true });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const BASE = `http://127.0.0.1:${port}`;

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();

  // Capture the app's WebSocket instances so tests can simulate a drop without
  // adding test-only globals to production code. Runs on every navigation.
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    window.WebSocket = class extends OrigWS {
      constructor(...args) { super(...args); window.__testWs = this; }
    };
  });

  console.log('\nUI Smoke Test: File Viewer Feature\n');
  await page.goto(BASE);
  await page.waitForTimeout(1000);

  // --- Initial Layout ---
  console.log('Section: Initial Layout');
  check('Sidebar shows "Projects" header',
    await page.textContent('.sidebar-title') === 'Projects');
  check('"+" button exists', !!(await page.$('#btn-add-project')));
  check('"Add Project" button visible', !!(await page.$('#btn-home-add-project')));
  check('Tab bar hidden when no session',
    await page.$eval('#tab-bar', el => getComputedStyle(el).display) === 'none');
  check('Shell pane hidden when no session',
    await page.$eval('#shell-pane', el => el.classList.contains('hidden')));
  check('Files pane hidden when no session',
    await page.$eval('#files-pane', el => el.classList.contains('hidden')));

  // --- Project + Session Creation ---
  console.log('\nSection: Project + Session Creation');
  const projRes = await page.evaluate(async (cwd) => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke Test', cwd }),
    });
    return res.json();
  }, tempDir);
  check('Project created', !!projRes.id, projRes.error);

  const sessRes = await page.evaluate(async (projectId) => {
    const res = await fetch(`/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke Session' }),
    });
    return res.json();
  }, projRes.id);
  check('Session created', !!sessRes.id, sessRes.error);

  // Expand project and click session to attach
  await page.waitForTimeout(1500);
  const projectHeaders = await page.$$('.project-header');
  for (const header of projectHeaders) {
    const nameText = await header.$eval('.project-name', el => el.textContent).catch(() => '');
    if (nameText === 'Smoke Test') {
      await header.click();
      await page.waitForTimeout(500);
      break;
    }
  }
  await page.locator('.project-sessions.expanded li:has-text("Smoke Session")').first()
    .click({ timeout: 5000 });
  await page.waitForTimeout(1000);

  // --- Session Row Controls ---
  console.log('\nSection: Session Row Controls');
  check('Archive button removed', (await page.$$('.session-archive')).length === 0);
  check('New-session (+) button in project header',
    !!(await page.$('.project-header .project-new-session')));
  check('Bottom "+ New Session" row removed', (await page.$$('.btn-new-session')).length === 0);

  // Merge-to-local button present on a session with a worktree branch
  check('Merge-to-local button present on session',
    !!(await page.$('.project-sessions.expanded li .session-merge')));

  // New-session (+) in header opens the inline input.
  // The button is hover-revealed on desktop, so hover the header first.
  const smokeHeader = page.locator('.project-header:has(.project-name:text-is("Smoke Test"))').first();
  await smokeHeader.hover();
  await page.waitForTimeout(150);
  await smokeHeader.locator('.project-new-session').click();
  await page.waitForTimeout(400);
  check('Header + opens inline session input', !!(await page.$('.inline-session-input')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Closing a session shows a confirmation dialog (single confirm).
  // The delete button is hover-revealed, so hover the row first.
  const smokeSessionLi = page.locator('.project-sessions.expanded li:has-text("Smoke Session")').first();
  await smokeSessionLi.hover();
  await page.waitForTimeout(150);
  await smokeSessionLi.locator('.session-delete').click();
  await page.waitForTimeout(400);
  check('Close session shows confirm dialog', !!(await page.$('.confirm-overlay')));
  check('Confirm dialog titled "Close Session"',
    (await page.$eval('.confirm-dialog h3', el => el.textContent).catch(() => '')) === 'Close Session');
  // Escape dismisses the dialog (incidental dismissal path) and keeps session
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape dismisses confirm dialog', !(await page.$('.confirm-overlay')));
  check('Escape keeps the session',
    !!(await page.$('.project-sessions.expanded li:has-text("Smoke Session")')));

  // Re-open and Cancel via button — session must survive
  await smokeSessionLi.hover();
  await page.waitForTimeout(150);
  await smokeSessionLi.locator('.session-delete').click();
  await page.waitForTimeout(300);
  await page.locator('.confirm-cancel').first().click();
  await page.waitForTimeout(300);
  check('Cancel keeps the session',
    !!(await page.$('.project-sessions.expanded li:has-text("Smoke Session")')));

  // --- Session lock (eye) ---
  console.log('\nSection: Session lock');
  const smokeLi = page.locator('.project-sessions.expanded li:has-text("Smoke Session")').first();
  await smokeLi.hover();
  await page.waitForTimeout(150);
  check('Lock button present in session row', !!(await smokeLi.locator('.session-lock').count()));
  await smokeLi.locator('.session-lock').click();
  await page.waitForTimeout(200);
  check('Session row gets .locked when locked',
    await smokeLi.evaluate(el => el.classList.contains('locked')));
  check('Locked session row is non-interactive (pointer-events:none)',
    await smokeLi.evaluate(el => getComputedStyle(el).pointerEvents === 'none'));
  // Lock button itself stays clickable within a locked row
  await smokeLi.locator('.session-lock').click();
  await page.waitForTimeout(200);
  check('Session row un-locked after toggle off',
    await smokeLi.evaluate(el => !el.classList.contains('locked')));

  // --- Tab Bar (fixed tabs) ---
  console.log('\nSection: Tab Bar');
  check('Tab bar visible',
    await page.$eval('#tab-bar', el => getComputedStyle(el).display) !== 'none');
  const tabBarText = await page.$eval('#tab-list', el => el.textContent);
  check('Claude tab present', tabBarText.includes('Claude'));
  check('History tab present', tabBarText.includes('History'));
  check('Terminal tab present', tabBarText.includes('Terminal'));
  check('Files tab present', tabBarText.includes('Files'));
  // History must come before Terminal in the tab order
  const tabLabels = await page.$$eval('#tab-list .tab-label', els => els.map(e => e.textContent));
  check('History tab is before Terminal',
    tabLabels.indexOf('History') !== -1 &&
    tabLabels.indexOf('History') < tabLabels.indexOf('Terminal'),
    JSON.stringify(tabLabels));

  // --- Select-mode toggle ---
  console.log('\nSection: Select-mode toggle');
  check('Select-mode toggle present', !!(await page.$('#select-mode-toggle')));
  check('Select mode defaults OFF (not active)',
    await page.$eval('#select-mode-toggle', el => !el.classList.contains('active')));
  check('Toggle label shows Off by default',
    (await page.$eval('#select-mode-toggle', el => el.textContent)).includes('Off'));
  await page.locator('#select-mode-toggle').click();
  await page.waitForTimeout(200);
  check('Clicking activates Select mode (active class)',
    await page.$eval('#select-mode-toggle', el => el.classList.contains('active')));
  await page.locator('#select-mode-toggle').click(); // restore OFF for later sections
  await page.waitForTimeout(200);

  // --- History Tab ---
  console.log('\nSection: History Tab');
  await page.locator('.tab:has-text("History")').first().click();
  await page.waitForTimeout(600);
  check('History pane visible on History tab',
    await page.$eval('#history-pane', el => !el.classList.contains('hidden')));
  check('History content rendered (empty note or turns)',
    (await page.$eval('#history-content', el => el.textContent)).length > 0);

  // --- Terminal Tab ---
  console.log('\nSection: Terminal Tab');
  await page.locator('.tab:has-text("Terminal")').first().click();
  await page.waitForTimeout(400);
  check('Shell pane visible on Terminal tab',
    await page.$eval('#shell-pane', el => !el.classList.contains('hidden')));
  check('Claude terminal hidden on Terminal tab',
    await page.$eval('#terminal-wrapper', el => getComputedStyle(el).display) === 'none');

  // --- Files Tab + File Tree ---
  console.log('\nSection: Files Tab');
  await page.locator('.tab:has-text("Files")').first().click();
  await page.waitForTimeout(400);
  check('Files pane visible on Files tab',
    await page.$eval('#files-pane', el => !el.classList.contains('hidden')));
  check('Files header present',
    await page.$eval('#files-pane .pane-title', el => el.textContent) === 'Files');
  await page.waitForTimeout(1500);
  const treeItems = await page.$$('.file-tree-item');
  check('File tree has entries', treeItems.length > 0, `found ${treeItems.length}`);
  const treeText = await page.$eval('#file-tree', el => el.textContent);
  check('Shows README.md', treeText.includes('README.md'));
  check('Shows app.js', treeText.includes('app.js'));
  check('Shows src directory', treeText.includes('src'));

  // Files scope toggle: switch to project root, then back to worktree
  check('Scope toggle present', !!(await page.$('#files-scope-toggle')));
  check('Scope toggle starts as "Project root"',
    (await page.$eval('#files-scope-toggle', el => el.textContent)) === 'Project root');
  await page.locator('#files-scope-toggle').click();
  await page.waitForTimeout(1200);
  check('Scope toggle flips to "Session worktree"',
    (await page.$eval('#files-scope-toggle', el => el.textContent)) === 'Session worktree');
  check('Project-root tree still has entries',
    (await page.$$('.file-tree-item')).length > 0);
  await page.locator('#files-scope-toggle').click();
  await page.waitForTimeout(1200);
  check('Scope toggle returns to "Project root"',
    (await page.$eval('#files-scope-toggle', el => el.textContent)) === 'Project root');

  // --- Markdown Viewer ---
  console.log('\nSection: Markdown Viewer');
  await page.locator('.file-tree-item:has-text("README.md")').first().click();
  await page.waitForTimeout(1000);
  check('File viewer visible',
    await page.$eval('#file-viewer', el => !el.classList.contains('hidden')));
  check('Markdown class applied',
    (await page.$eval('#file-viewer-content', el => el.className)).includes('markdown-body'));
  const fvHtml = await page.$eval('#file-viewer-content', el => el.innerHTML);
  check('Rendered as HTML', fvHtml.includes('<h1') || fvHtml.includes('<p'));
  check('Tab created', (await page.$$('.tab')).length >= 2);
  check('Path shown in toolbar',
    (await page.$eval('#file-viewer-path', el => el.textContent)).includes('README.md'));

  // --- Plain Text Viewer ---
  console.log('\nSection: Plain Text Viewer');
  // Return to Files tab (opening README switched to its viewer tab)
  await page.locator('.tab:has-text("Files")').first().click();
  await page.waitForTimeout(400);
  await page.locator('.file-tree-item:has-text("app.js")').first().click();
  await page.waitForTimeout(1000);
  check('Plain text class',
    (await page.$eval('#file-viewer-content', el => el.className)).includes('plain-text'));
  check('JS content displayed',
    (await page.$eval('#file-viewer-content', el => el.textContent)).includes('console.log'));

  // --- Tab Switching ---
  console.log('\nSection: Tab Switching');
  await page.locator('.tab:has-text("Claude")').first().click();
  await page.waitForTimeout(500);
  check('Terminal visible after Claude tab',
    await page.$eval('#terminal-wrapper', el => getComputedStyle(el).display) !== 'none');
  check('File viewer hidden after Claude tab',
    await page.$eval('#file-viewer', el => el.classList.contains('hidden')));
  const termInset = await page.$eval('#terminal-wrapper', el => el.style.inset);
  check('No 32px gap (inset correct)', termInset.startsWith('32px'), termInset);

  // --- Shift+Enter sends CSI u sequence ---
  console.log('\nSection: Shift+Enter Key Handling');
  // Spy on WebSocket.send to capture outgoing messages
  await page.evaluate(() => {
    window.__wsSent = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      window.__wsSent.push(data);
      return origSend.call(this, data);
    };
  });
  // Focus the terminal textarea (offscreen element, use JS focus)
  await page.evaluate(() => document.querySelector('#terminal-wrapper .xterm-helper-textarea').focus());
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.__wsSent = []; }); // clear any focus-related messages
  await page.keyboard.press('Shift+Enter');
  await page.waitForTimeout(300);
  const shiftEnterMessages = await page.evaluate(() => window.__wsSent);
  const inputMsgs = shiftEnterMessages
    .map(m => { try { return JSON.parse(m); } catch { return null; } })
    .filter(m => m && m.type === 'input');
  check('Shift+Enter sends exactly one input message', inputMsgs.length === 1,
    `got ${inputMsgs.length}: ${JSON.stringify(inputMsgs)}`);
  if (inputMsgs.length > 0) {
    check('Shift+Enter sends CSI u sequence (\\x1b[13;2u)', inputMsgs[0].data === '\x1b[13;2u',
      `got: ${JSON.stringify(inputMsgs[0].data)}`);
  }
  // Verify plain Enter still sends \r
  await page.evaluate(() => { window.__wsSent = []; });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const enterMessages = await page.evaluate(() => window.__wsSent);
  const enterInputMsgs = enterMessages
    .map(m => { try { return JSON.parse(m); } catch { return null; } })
    .filter(m => m && m.type === 'input');
  check('Plain Enter sends \\r', enterInputMsgs.length === 1 && enterInputMsgs[0].data === '\r',
    `got: ${JSON.stringify(enterInputMsgs)}`);

  // --- Multi-line paste bracketing (Claude tab) ---
  // With bracketed-paste mode OFF (testMode bash session hasn't enabled it),
  // a multi-line text paste must be sent as ONE bracketed block, not multiple
  // \r Enters. Dispatch a synthetic paste event with multi-line clipboard text.
  await page.locator('.tab:has-text("Claude")').first().click();
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.__wsSent = []; });
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text', 'line1\nline2\nline3');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    // Dispatch on the terminal element so the capture-phase paste listener
    // (which preempts xterm) receives it, matching a real in-terminal paste.
    document.getElementById('terminal').dispatchEvent(ev);
  });
  await page.waitForTimeout(200);
  const pasteMsgs = (await page.evaluate(() => window.__wsSent))
    .map(m => { try { return JSON.parse(m); } catch { return null; } })
    .filter(m => m && m.type === 'input');
  const bracketed = pasteMsgs.find(m => m.data.includes('\x1b[200~') && m.data.includes('\x1b[201~'));
  check('Multi-line paste sent as one bracketed block', !!bracketed,
    `got: ${JSON.stringify(pasteMsgs)}`);
  check('Bracketed paste preserves newlines (no bare \\r submits)',
    !!bracketed && bracketed.data.includes('line1\nline2\nline3'));

  // --- Tab Close ---
  console.log('\nSection: Tab Close');
  const tabsBefore = (await page.$$('.tab')).length;
  const closeBtn = await page.$('.tab-close');
  if (closeBtn) {
    await closeBtn.click();
    await page.waitForTimeout(300);
    check('Close button removes tab', (await page.$$('.tab')).length < tabsBefore);
    // Closing the last file tab returns to Files, not the Claude terminal.
    const noFileTabs = (await page.$$('.tab-close')).length === 0;
    if (noFileTabs) {
      check('Closing last file tab returns to Files pane',
        await page.$eval('#files-pane', el => !el.classList.contains('hidden')));
    }
  }

  // --- Mobile Layout ---
  console.log('\nSection: Mobile Layout');

  // Resize to mobile viewport
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(1000);

  // Core layout checks
  check('Mobile topbar visible',
    await page.$eval('#mobile-topbar', el => getComputedStyle(el).display) === 'flex');
  check('Shell pane hidden on mobile',
    await page.$eval('#shell-pane', el => getComputedStyle(el).display) === 'none');
  check('Files pane hidden on mobile',
    await page.$eval('#files-pane', el => getComputedStyle(el).display) === 'none');
  check('Tab bar hidden on mobile',
    await page.$eval('#tab-bar', el => getComputedStyle(el).display) === 'none');
  check('Sidebar is fixed-position on mobile',
    await page.$eval('#sidebar', el => getComputedStyle(el).position) === 'fixed');

  // Test session name in topbar
  check('Session name shown in topbar',
    (await page.$eval('#mobile-session-name', el => el.textContent)).includes('Smoke Session'));

  // Test mobile new session button visible
  check('Mobile new session button visible',
    await page.$eval('#mobile-new-session', el => getComputedStyle(el).display) !== 'none');

  // Test hamburger opens sidebar
  await page.click('#mobile-hamburger');
  await page.waitForTimeout(500);
  check('Sidebar opens on hamburger click',
    await page.$eval('#sidebar', el => el.classList.contains('open')));
  check('Backdrop visible when sidebar open',
    await page.$eval('#sidebar-backdrop', el => el.classList.contains('visible')));

  // Test touch targets (44px minimum height)
  const sessionItems = await page.$$('.project-sessions li');
  check('Session list items found', sessionItems.length > 0, `found ${sessionItems.length}`);
  if (sessionItems.length > 0) {
    const itemHeight = await sessionItems[0].evaluate(el => el.getBoundingClientRect().height);
    check('Session touch target >= 44px', itemHeight >= 44, `got ${Math.round(itemHeight)}px`);
  }

  // Test backdrop closes sidebar — click at x=350 (right of 240px sidebar)
  await page.mouse.click(350, 400);
  await page.waitForTimeout(500);
  check('Sidebar closes on backdrop click',
    await page.$eval('#sidebar', el => !el.classList.contains('open')));

  // Test session click closes sidebar. Click the status dot (leftmost, always
  // present, no own handler → event bubbles to the row's onclick), avoiding the
  // right-side action buttons that stopPropagation.
  await page.click('#mobile-hamburger');
  await page.waitForTimeout(500);
  const sessionDot = await page.$('.project-sessions li .status-dot');
  if (sessionDot) {
    await sessionDot.click();
    await page.waitForTimeout(500);
    check('Session click closes sidebar',
      await page.$eval('#sidebar', el => !el.classList.contains('open')));
  }

  // Test new session button opens sidebar
  await page.click('#mobile-new-session');
  await page.waitForTimeout(500);
  check('New session button opens sidebar',
    await page.$eval('#sidebar', el => el.classList.contains('open')));
  await page.mouse.click(350, 400);
  await page.waitForTimeout(500);

  // Test modal z-index above sidebar backdrop
  await page.click('#mobile-hamburger');
  await page.waitForTimeout(500);
  await page.click('#btn-add-project');
  await page.waitForTimeout(500);
  const modalZ = await page.$eval('#modal-overlay', el => parseInt(getComputedStyle(el).zIndex));
  const backdropZ = await page.$eval('#sidebar-backdrop', el => parseInt(getComputedStyle(el).zIndex));
  check('Modal z-index above sidebar backdrop', modalZ > backdropZ,
    `modal=${modalZ}, backdrop=${backdropZ}`);
  await page.click('#btn-modal-cancel');
  await page.waitForTimeout(300);
  await page.mouse.click(350, 400);
  await page.waitForTimeout(500);

  // Test Recent sessions section visible on mobile
  await page.click('#mobile-hamburger');
  await page.waitForTimeout(500);
  const recentText = await page.$eval('.mobile-recent-label', el => el.textContent).catch(() => '');
  check('Recent sessions section visible', recentText === 'Recent');

  // Test session actions always visible on mobile
  const sessionActionsDisplay = await page.$eval('.session-actions',
    el => getComputedStyle(el).display).catch(() => 'none');
  check('Session actions visible on mobile', sessionActionsDisplay === 'flex');

  // Test project delete always visible on mobile
  const projDeleteDisplay = await page.$eval('.project-delete',
    el => getComputedStyle(el).display).catch(() => 'none');
  check('Project delete visible on mobile', projDeleteDisplay !== 'none');

  // Test project header touch target (skip the non-interactive Recent header)
  const projHeaderHeight = await page.$eval('.project-header:not(.mobile-recent-header)',
    el => el.getBoundingClientRect().height);
  check('Project header touch target >= 44px', projHeaderHeight >= 44,
    `got ${Math.round(projHeaderHeight)}px`);

  // Test mobileSessionInfo click opens sidebar
  await page.mouse.click(350, 400);
  await page.waitForTimeout(500);
  await page.click('#mobile-session-info');
  await page.waitForTimeout(500);
  check('Session info click opens sidebar',
    await page.$eval('#sidebar', el => el.classList.contains('open')));

  // Test breakpoint crossing closes sidebar (sidebar is currently open)
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(1000);
  check('Breakpoint crossing closes sidebar',
    await page.$eval('#sidebar', el => !el.classList.contains('open')));

  // Return to mobile viewport for remaining checks
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(1000);

  // Restore desktop viewport and verify layout restoration
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(1000);
  check('Tab bar visible after restore',
    await page.$eval('#tab-bar', el => getComputedStyle(el).display) !== 'none');
  check('Mobile topbar hidden after restore',
    await page.$eval('#mobile-topbar', el => getComputedStyle(el).display) === 'none');
  check('Sidebar not fixed after restore',
    await page.$eval('#sidebar', el => getComputedStyle(el).position) !== 'fixed');
  check('Sidebar aria-hidden after restore',
    await page.$eval('#sidebar', el => el.getAttribute('aria-hidden')) === 'true');

  // --- Directory Expand ---
  console.log('\nSection: Directory Expand');
  // Ensure the Files tab is active so the tree is visible
  await page.locator('.tab:has-text("Files")').first().click();
  await page.waitForTimeout(400);
  await page.locator('.file-tree-folder:has-text("src")').first().click();
  await page.waitForTimeout(1000);
  check('src expands', !!(await page.$('.file-tree-children.expanded')));
  const childText = await page.$eval('.file-tree-children.expanded', el => el.textContent).catch(() => '');
  check('Shows index.js', childText.includes('index.js'));

  // --- Auto-select last session on refresh ---
  console.log('\nSection: Auto-select on Refresh');
  // We attached "Smoke Session" earlier, so it should be persisted. Reload.
  await page.reload();
  await page.waitForTimeout(2500);
  check('Session auto-selected after refresh (welcome screen hidden)',
    await page.$eval('#no-session', el => el.classList.contains('hidden')));
  check('Tab bar visible after refresh (a session is active)',
    await page.$eval('#tab-bar', el => getComputedStyle(el).display) !== 'none');

  // --- Connection banner on WS drop ---
  console.log('\nSection: Connection Banner');
  check('Banner hidden while connected',
    await page.$eval('#connection-banner', el => el.classList.contains('hidden')));
  // Force-close the client WebSocket and confirm the reconnecting UI appears.
  await page.evaluate(() => { if (window.__testWs) window.__testWs.close(); });
  await page.waitForTimeout(400);
  const bannerShown = await page.$eval('#connection-banner', el => !el.classList.contains('hidden'));
  const bodyDisconnected = await page.$eval('body', el => el.classList.contains('ws-disconnected'));
  check('Banner shown after WS close', bannerShown);
  check('Body marked ws-disconnected after WS close', bodyDisconnected);
  // It should auto-reconnect and clear the banner.
  await page.waitForTimeout(2500);
  check('Banner clears after auto-reconnect',
    await page.$eval('#connection-banner', el => el.classList.contains('hidden')));

  // Summary
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} checks`);
  console.log(`${'='.repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);

} catch (err) {
  console.error('\nSmoke test error:', err.message);
  process.exit(1);
} finally {
  if (browser) await browser.close();
  if (server) await server.destroy();
  if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}
