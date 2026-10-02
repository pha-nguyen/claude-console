import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { createEvent, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage } from '@/shared/types';

const noop = () => undefined;
const message: ChatMessage = {
  type: 'assistant',
  content: 'Before.\n\n```text\n  first line\n\n\n  last line\n```\n\nAfter.',
  timestamp: '2026-10-02T00:00:00Z',
};

function renderPane() {
  const props: ComponentProps<typeof ChatMessagesPane> = {
    scrollContainerRef: createRef<HTMLDivElement>(),
    textareaRef: createRef<HTMLTextAreaElement>(),
    onWheel: vi.fn(),
    onTouchMove: vi.fn(),
    isLoadingSessionMessages: false,
    chatMessages: [message],
    selectedSession: null,
    currentSessionId: null,
    provider: 'codex',
    setProvider: noop,
    providerModels: { claude: '', codex: '', cursor: '', opencode: '' },
    setProviderModel: noop,
    providerModelCatalog: {},
    providerModelActions: {
      create: async () => undefined,
      update: async () => undefined,
      remove: async () => undefined,
    },
    providerModelsLoading: false,
    tasksEnabled: false,
    isTaskMasterInstalled: false,
    setInput: noop,
    isLoadingMoreMessages: false,
    hasMoreMessages: false,
    totalMessages: 1,
    sessionMessagesCount: 1,
    visibleMessageCount: 1,
    visibleMessages: [message],
    loadEarlierMessages: noop,
    revealMessage: noop,
    sendMessage: noop,
    loadAllMessages: noop,
    allMessagesLoaded: true,
    isLoadingAllMessages: false,
    loadAllJustFinished: false,
    showLoadAllOverlay: false,
    createDiff: () => [],
    onGrantToolPermission: () => ({ success: true }),
    selectedProject: { projectId: 'test-project', fullPath: '/test-project', displayName: 'Test' },
  };
  const view = render(<UiPreferencesProvider><ChatMessagesPane {...props} /></UiPreferencesProvider>);
  return { ...view, pane: view.container.querySelector<HTMLDivElement>('.chat-messages-pane')! };
}

function selectContents(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

afterEach(() => window.getSelection()?.removeAllRanges());

test('selection copy writes plain text without collapsing code indentation or blank lines', () => {
  const { pane } = renderPane();
  const code = pane.querySelector('pre code')!;
  selectContents(code);
  const clipboardData = { setData: vi.fn() };
  const event = createEvent.copy(code, { clipboardData });

  fireEvent(code, event);

  expect(event.defaultPrevented).toBe(true);
  expect(clipboardData.setData.mock.calls).toEqual([
    ['text/plain', '  first line\n\n\n  last line'],
  ]);
});

test('copy leaves editable fields and selections outside the conversation to the browser', () => {
  const { pane } = renderPane();
  selectContents(pane.querySelector('pre code')!);
  const input = document.createElement('textarea');
  input.value = 'An answer being edited';
  pane.append(input);
  const clipboardData = { setData: vi.fn() };

  const inputEvent = createEvent.copy(input, { clipboardData });
  fireEvent(input, inputEvent);
  expect(inputEvent.defaultPrevented).toBe(false);

  const outside = document.createElement('div');
  outside.textContent = 'Outside the conversation';
  document.body.append(outside);
  selectContents(outside);
  const outsideEvent = createEvent.copy(pane, { clipboardData });
  fireEvent(pane, outsideEvent);
  expect(outsideEvent.defaultPrevented).toBe(false);
  expect(clipboardData.setData).not.toHaveBeenCalled();
  outside.remove();
});
