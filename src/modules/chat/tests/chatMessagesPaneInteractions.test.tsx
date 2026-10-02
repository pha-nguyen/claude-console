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

function renderPane(entry = message) {
  const props: ComponentProps<typeof ChatMessagesPane> = {
    scrollContainerRef: createRef<HTMLDivElement>(),
    textareaRef: createRef<HTMLTextAreaElement>(),
    onWheel: vi.fn(),
    onTouchMove: vi.fn(),
    isLoadingSessionMessages: false,
    chatMessages: [entry],
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
    visibleMessages: [entry],
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

test.each([
  ['Plain user message.', 'Plain user message.'],
  ['First paragraph.\n\nLast paragraph.', 'Last paragraph.'],
  ['First paragraph.\n\nLast **bold** and `code`.', 'Last bold and code.'],
])('triple-click selection stays inside user content: %s', (content, expected) => {
  const { pane } = renderPane({ ...message, type: 'user', content });
  const body = pane.querySelector('.chat-message.user [dir="auto"]')!;
  const paragraph = body.querySelector('.prose > div:last-child')!;
  const copyLabel = pane.querySelector('button[aria-label="Copy message"] span')!;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.setStart(paragraph.firstChild!, 0);
  // Chrome's native triple click includes the boundary before the TXT label.
  range.setEnd(copyLabel, 0);
  selection.addRange(range);

  fireEvent.click(paragraph, { detail: 3 });

  expect(body.contains(selection.anchorNode)).toBe(true);
  expect(body.contains(selection.focusNode)).toBe(true);
  expect(selection.toString()).toBe(expected);
  const clipboardData = { setData: vi.fn() };
  fireEvent.copy(paragraph, { clipboardData });
  expect(clipboardData.setData.mock.calls).toEqual([['text/plain', expected]]);
});

test.each([1, 2])('%s clicks leave native selection boundaries alone', (detail) => {
  const { pane } = renderPane({ ...message, type: 'user', content: 'A user message.' });
  const body = pane.querySelector('.chat-message.user [dir="auto"]')!;
  const paragraph = body.querySelector('.prose > div')!;
  const copyLabel = pane.querySelector('button[aria-label="Copy message"] span')!;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.setStart(paragraph.firstChild!, 0);
  range.setEnd(copyLabel, 0);
  selection.addRange(range);

  fireEvent.click(paragraph, { detail });

  expect(selection.focusNode).toBe(copyLabel);
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
