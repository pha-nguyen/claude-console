import { createEvent, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { handleMacTextareaNavigation } from '@/modules/chat/utils/macTextareaNavigation';

const DRAFT = 'First line\nSecond line\nThird line\nFourth line';
let targetOffset = 0;
let caretTop = 10;
let nativeSelection: Selection;
let modify: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  nativeSelection = window.getSelection()!;
  targetOffset = 0;
  caretTop = 10;
  // jsdom has no layout or Selection.modify. Browser tests cover actual wrapped
  // line movement; here its returned caret exercises selection and scroll handling.
  modify = vi.fn(() => nativeSelection.collapse(nativeSelection.focusNode, targetOffset));
  vi.spyOn(document, 'getSelection').mockReturnValue({
    get focusNode() { return nativeSelection.focusNode; },
    get focusOffset() { return nativeSelection.focusOffset; },
    collapse: nativeSelection.collapse.bind(nativeSelection),
    removeAllRanges: nativeSelection.removeAllRanges.bind(nativeSelection),
    modify,
  } as unknown as Selection);
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange();
    range.getBoundingClientRect = () => new DOMRect(0, caretTop, 0, 20);
    return range;
  });
});

afterEach(() => nativeSelection.removeAllRanges());

function renderInput() {
  const view = render(<textarea
    aria-label="Message"
    defaultValue={DRAFT}
    style={{ font: '16px/20px monospace', padding: '10px' }}
    onKeyDown={handleMacTextareaNavigation}
  />);
  const input = view.getByRole('textbox') as HTMLTextAreaElement;
  Object.defineProperty(input, 'clientHeight', { value: 100 });
  Object.defineProperty(input, 'clientWidth', { value: 200 });
  input.focus();
  input.setSelectionRange(16, 16);
  return input;
}

test('Mac Home/End move the caret without changing the draft or moving focus', () => {
  const input = renderInput();
  targetOffset = 11;
  const home = createEvent.keyDown(input, { key: 'Home' });
  fireEvent(input, home);
  expect(home.defaultPrevented).toBe(true);
  expect(input.selectionStart).toBe(11);
  expect(input.selectionEnd).toBe(11);
  expect(modify).toHaveBeenLastCalledWith('move', 'backward', 'lineboundary');

  targetOffset = 22;
  fireEvent.keyDown(input, { key: 'End' });
  expect(input.selectionStart).toBe(22);
  expect(modify).toHaveBeenLastCalledWith('move', 'forward', 'lineboundary');
  expect(input.value).toBe(DRAFT);
  expect(document.activeElement).toBe(input);
  expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
});

test('Shift keeps the original anchor when selection reverses direction', () => {
  const input = renderInput();
  targetOffset = 11;
  fireEvent.keyDown(input, { key: 'Home', shiftKey: true });
  expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([11, 16, 'backward']);

  targetOffset = 22;
  fireEvent.keyDown(input, { key: 'End', shiftKey: true });
  expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([16, 22, 'forward']);
});

test('PageUp/PageDown use the input viewport and scroll to keep the caret visible', () => {
  const input = renderInput();
  targetOffset = 30;
  caretTop = 150;
  fireEvent.keyDown(input, { key: 'PageDown', shiftKey: true });
  // Four visible 20px rows, with one row of overlap between pages.
  expect(modify.mock.calls).toEqual(Array(3).fill(['move', 'forward', 'line']));
  expect([input.selectionStart, input.selectionEnd]).toEqual([16, 30]);
  expect(input.scrollTop).toBe(80);

  modify.mockClear();
  targetOffset = 0;
  caretTop = 10;
  fireEvent.keyDown(input, { key: 'PageUp' });
  expect(modify.mock.calls).toEqual(Array(3).fill(['move', 'backward', 'line']));
  expect(input.selectionStart).toBe(0);
  expect(input.scrollTop).toBe(0);
  expect(input.value).toBe(DRAFT);
});

test.each(['Linux x86_64', 'Win32'])('%s keeps native key handling', (platform) => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  const input = renderInput();
  const event = createEvent.keyDown(input, { key: 'Home' });
  fireEvent(input, event);
  expect(event.defaultPrevented).toBe(false);
  expect(modify).not.toHaveBeenCalled();
});

test.each([
  { metaKey: true }, { ctrlKey: true }, { altKey: true }, { isComposing: true },
])('leaves modifiers and IME navigation alone: %o', (options) => {
  const input = renderInput();
  const event = createEvent.keyDown(input, { key: 'Home', ...options });
  fireEvent(input, event);
  expect(event.defaultPrevented).toBe(false);
  expect(modify).not.toHaveBeenCalled();
});

test('respects a key already handled by a caller', () => {
  const input = renderInput();
  const event = createEvent.keyDown(input, { key: 'Home' });
  event.preventDefault();
  fireEvent(input, event);
  expect(modify).not.toHaveBeenCalled();
});
