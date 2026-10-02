import assert from 'node:assert/strict';

import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import type { AppTab } from '@/shared/types';

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [] }),
  PluginIcon: () => null,
}));

function WorkspaceTabHarness() {
  // Exercise tab selection through the same controlled state as the workspace.
  const [activeTab, setActiveTab] = useState<AppTab>('chat');
  return <WorkspaceTabs activeTab={activeTab} setActiveTab={setActiveTab} shouldShowTasksTab={false} shouldShowBrowserTab={false} />;
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('Terminal appears between Chat and Shell in the workspace menu', () => {
  render(<WorkspaceTabHarness />);
  assert.deepEqual(
    screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label')),
    ['Chat', 'Terminal', 'Shell', 'Files', 'Source Control'],
  );
});

test('Terminal and Shell can be selected independently by mouse and keyboard', () => {
  render(<WorkspaceTabHarness />);
  const terminal = screen.getByRole('tab', { name: 'Terminal' });
  const shell = screen.getByRole('tab', { name: 'Shell' });

  fireEvent.click(terminal);
  assert.equal(terminal.getAttribute('aria-selected'), 'true');
  assert.equal(shell.getAttribute('aria-selected'), 'false');

  fireEvent.keyDown(terminal, { key: 'ArrowRight' });
  assert.equal(shell.getAttribute('aria-selected'), 'true');
  assert.equal(terminal.getAttribute('aria-selected'), 'false');
});
