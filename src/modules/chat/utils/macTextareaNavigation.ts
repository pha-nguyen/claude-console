import type { KeyboardEvent } from 'react';

const MIRROR_STYLE_PROPERTIES = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'lineHeight',
  'letterSpacing', 'wordSpacing', 'textIndent', 'textAlign', 'textTransform',
  'direction', 'tabSize', 'wordBreak', 'overflowWrap',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
] as const;

/**
 * Used by the chat composer to give macOS Home/End and paging keys caret
 * movement. A temporary text mirror lets the browser resolve wrapped lines,
 * proportional fonts and Unicode without relying on textarea Selection.modify,
 * which Firefox does not implement.
 */
export function handleMacTextareaNavigation(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (!navigator.platform.startsWith('Mac') || event.defaultPrevented
    || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return false;
  if (!['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return false;

  const textarea = event.currentTarget;
  const document = textarea.ownerDocument;
  const selection = document.getSelection();
  if (!selection || typeof selection.modify !== 'function') return false;

  const style = getComputedStyle(textarea);
  const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 16) * 1.2;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingBottom = parseFloat(style.paddingBottom) || 0;
  const isBackward = event.key === 'Home' || event.key === 'PageUp';
  const isPage = event.key === 'PageUp' || event.key === 'PageDown';
  const steps = isPage
    ? Math.max(1, Math.floor((textarea.clientHeight - paddingTop - paddingBottom) / lineHeight) - 1)
    : 1;
  const anchor = textarea.selectionDirection === 'backward' ? textarea.selectionEnd : textarea.selectionStart;
  const caret = textarea.selectionDirection === 'backward' ? textarea.selectionStart : textarea.selectionEnd;
  const mirror = document.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  for (const property of MIRROR_STYLE_PROPERTIES) mirror.style[property] = style[property];
  Object.assign(mirror.style, {
    position: 'fixed', left: '-100000px', top: '0', pointerEvents: 'none',
    boxSizing: 'border-box', width: `${textarea.clientWidth}px`,
    whiteSpace: textarea.wrap === 'off' ? 'pre' : 'pre-wrap',
  });
  // A zero-width final character gives an empty last line a measurable caret.
  const text = document.createTextNode(`${textarea.value}\u200b`);
  mirror.append(text);
  document.body.append(mirror);

  let nextCaret = caret;
  let caretTop = 0;
  try {
    selection.collapse(text, caret);
    for (let step = 0; step < steps; step += 1) {
      selection.modify('move', isBackward ? 'backward' : 'forward', isPage ? 'line' : 'lineboundary');
      if (selection.focusNode !== text) {
        nextCaret = isBackward ? 0 : textarea.value.length;
        break;
      }
      nextCaret = Math.min(selection.focusOffset, textarea.value.length);
    }
    const range = document.createRange();
    range.setStart(text, nextCaret);
    range.collapse(true);
    caretTop = range.getBoundingClientRect().top - mirror.getBoundingClientRect().top;
  } finally {
    selection.removeAllRanges();
    mirror.remove();
  }

  event.preventDefault();
  textarea.setSelectionRange(
    event.shiftKey ? Math.min(anchor, nextCaret) : nextCaret,
    event.shiftKey ? Math.max(anchor, nextCaret) : nextCaret,
    event.shiftKey && nextCaret < anchor ? 'backward' : 'forward',
  );
  // Programmatic caret movement does not reveal the caret in a scrolled textarea.
  if (isPage) textarea.scrollTop += (isBackward ? -1 : 1) * steps * lineHeight;
  if (caretTop < textarea.scrollTop + paddingTop) {
    textarea.scrollTop = Math.max(0, caretTop - paddingTop);
  } else if (caretTop + lineHeight > textarea.scrollTop + textarea.clientHeight - paddingBottom) {
    textarea.scrollTop = caretTop + lineHeight - textarea.clientHeight + paddingBottom;
  }
  return true;
}
