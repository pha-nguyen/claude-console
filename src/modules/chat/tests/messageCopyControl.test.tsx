import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import MessageCopyControl from '@/modules/chat/transcript/MessageCopyControl';

const writeText = vi.fn().mockResolvedValue(undefined);
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  writeText.mockClear();
});

function renderCopyControl(content: string, messageType: 'user' | 'assistant') {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return render(<MessageCopyControl content={content} messageType={messageType} />);
}

test.each([
  '  first line\n    second line\n\n\nlast line  \n',
  '# Instructions\n- Keep **bold** and _identifier_names_.\n- Keep <literal> tags.',
  '```bash\nprintf "first\\n"\n\n\nprintf "last\\n"\n```\n',
  'First line\r\nSecond line\r\n\r\nLast line\r\n',
])('user Copy preserves the original message: %j', async (content) => {
  const view = renderCopyControl(content, 'user');

  fireEvent.click(view.getByRole('button', { name: 'Copy message' }));

  await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(content));
  expect(view.queryByRole('button', { name: 'Select copy format' })).toBeNull();
});

test('assistant Copy still offers markdown and readable text', async () => {
  const content = 'Please use **bold** and `code`.\n\nNext paragraph.';
  const view = renderCopyControl(content, 'assistant');

  fireEvent.click(view.getByRole('button', { name: 'Copy message' }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(content));

  fireEvent.click(view.getByRole('button', { name: 'Select copy format' }));
  fireEvent.click(view.getByRole('button', { name: 'Copy as text' }));
  fireEvent.click(view.getByRole('button', { name: 'Message copied' }));

  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('Please use bold and code.\n\nNext paragraph.'));
});
