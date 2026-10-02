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

test('user messages render and copy literal text with their original whitespace', () => {
  const content = '  Please keep **bold** and <literal> tags.\n- First item\n- Second item\n\n\n  Last line  \n';
  const { pane } = renderPane({ ...message, type: 'user', content });
  const body = pane.querySelector('.chat-message.user [dir="auto"]')!;
  expect(body.textContent).toBe(content);
  selectContents(body);
  const clipboardData = { setData: vi.fn() };

  fireEvent.copy(body, { clipboardData });

  expect(clipboardData.setData.mock.calls).toEqual([['text/plain', content]]);
});

test('user selection copy avoids browser-generated breaks around CRLFs', () => {
  const content = 'First line\r\nSecond line\r\n\r\nLast line\r\n';
  const { pane } = renderPane({ ...message, type: 'user', content });
  const body = pane.querySelector('.chat-message.user [dir="auto"]')!;
  const selection = selectContents(body);
  // Firefox's rendered Selection string doubles these breaks; Range stays literal.
  vi.spyOn(selection, 'toString').mockReturnValue(content.replace(/\r\n/g, '\n\n'));
  const clipboardData = { setData: vi.fn() };

  fireEvent.copy(body, { clipboardData });

  expect(clipboardData.setData.mock.calls).toEqual([['text/plain', content]]);
});

test.each(['forward', 'backward'])('copying a %s partial user selection includes only the selected text', (direction) => {
  const content = 'First line\n\n  Second line\nThird line';
  const { pane } = renderPane({ ...message, type: 'user', content });
  const body = pane.querySelector('.chat-message.user [dir="auto"]')!;
  const text = body.firstChild!;
  const start = 6;
  const end = content.indexOf('Third');
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(text, direction === 'forward' ? start : end, text, direction === 'forward' ? end : start);
  const clipboardData = { setData: vi.fn() };

  fireEvent.copy(body, { clipboardData });

  expect(clipboardData.setData.mock.calls).toEqual([['text/plain', content.slice(start, end)]]);
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
