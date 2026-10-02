import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

import { MONOKAI_COLORS } from '@/shared/constants';
import type { Project, ProjectSession, QuickSettingsTab, SlashCommand } from '@/shared/types';

//----------------- CODE EDITOR THEME ------------

/** Builds the Monokai extension shared by the code-editor and prd-editor modules. */
export const createMonokaiEditorTheme = (): Extension => [
  EditorView.theme({
    '&': {
      color: MONOKAI_COLORS.foreground,
      backgroundColor: MONOKAI_COLORS.background,
    },
    '.cm-content': { caretColor: MONOKAI_COLORS.foreground },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: MONOKAI_COLORS.foreground },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: MONOKAI_COLORS.selection,
    },
    '.cm-panels': {
      backgroundColor: MONOKAI_COLORS.surface,
      color: MONOKAI_COLORS.foreground,
    },
    '.cm-searchMatch': {
      backgroundColor: `${MONOKAI_COLORS.yellow}30`,
      outline: `1px solid ${MONOKAI_COLORS.yellow}90`,
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: `${MONOKAI_COLORS.orange}50`,
    },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: MONOKAI_COLORS.panel },
    '.cm-selectionMatch': { backgroundColor: `${MONOKAI_COLORS.green}25` },
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: MONOKAI_COLORS.selection,
      outline: `1px solid ${MONOKAI_COLORS.comment}`,
    },
    '&.cm-focused .cm-nonmatchingBracket': { color: MONOKAI_COLORS.pink },
    '.cm-gutters': {
      backgroundColor: MONOKAI_COLORS.background,
      color: MONOKAI_COLORS.comment,
      border: 'none',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: MONOKAI_COLORS.panel,
      color: MONOKAI_COLORS.comment,
      border: 'none',
    },
    '.cm-tooltip': {
      backgroundColor: MONOKAI_COLORS.panel,
      color: MONOKAI_COLORS.foreground,
      border: `1px solid ${MONOKAI_COLORS.border}`,
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: MONOKAI_COLORS.selection,
      color: 'hsl(var(--link))',
    },
  }, { dark: true }),
  syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.operator, tags.operatorKeyword, tags.tagName], color: MONOKAI_COLORS.pink },
    { tag: [tags.name, tags.punctuation], color: MONOKAI_COLORS.foreground },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.attributeName], color: MONOKAI_COLORS.green },
    { tag: [tags.string, tags.character, tags.attributeValue], color: MONOKAI_COLORS.yellow },
    { tag: [tags.typeName, tags.className, tags.standard(tags.name)], color: MONOKAI_COLORS.cyan },
    { tag: [tags.number, tags.bool, tags.atom, tags.constant(tags.name)], color: MONOKAI_COLORS.purple },
    { tag: [tags.regexp, tags.escape, tags.annotation], color: MONOKAI_COLORS.orange },
    { tag: [tags.comment, tags.meta], color: MONOKAI_COLORS.comment },
    { tag: tags.heading, color: MONOKAI_COLORS.green, fontWeight: 'bold' },
    { tag: tags.link, color: MONOKAI_COLORS.cyan, textDecoration: 'underline' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.inserted, color: MONOKAI_COLORS.green },
    { tag: [tags.deleted, tags.invalid], color: MONOKAI_COLORS.pink },
  ])),
];

// ---------------------------

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

// ---------------------------

//----------------- TAILWIND CLASS COMPOSITION ------------

/**
 * Merges conditional class names and resolves conflicting Tailwind utilities so the
 * last-specified utility wins. Use it for every className built from props or state.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------

//----------------- CLIPBOARD ------------

/**
 * Copies text with `document.execCommand`, the only path that works in browsers or
 * contexts where the async Clipboard API is unavailable. Private to `copyTextToClipboard`.
 */
function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea when the Clipboard API
 * is blocked. Resolves to whether the copy succeeded so callers can show copied feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyToClipboard(text);
  }

  return copied;
}

// ---------------------------

//----------------- NOTIFICATION SOUND ------------

/** localStorage key holding the user's completion-sound preference. Private to the sound helpers. */
const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';

/** The browser's AudioContext constructor, including the webkit-prefixed fallback; undefined outside a browser. */
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

/** Lazily created and reused, because browsers cap how many AudioContexts a page may open. */
let audioContext: AudioContext | null = null;

/** Reports whether the user has left completion sounds on; defaults to on when unset. */
export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

/** Persists the user's completion-sound preference; call it from settings toggles. */
export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/** Returns the shared AudioContext, creating it on first use. Private to the sound helpers. */
const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

/** Schedules one synthesized sine tone on the shared context. Private to `playNotificationSound`. */
const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 */
export const playNotificationSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

/** Plays the chime for a finished assistant turn; named for the chat call site it serves. */
export const playChatCompletionSound = (options = {}): Promise<void> => playNotificationSound(options);

// ---------------------------

//----------------- DOCUMENT TITLE ------------

/** Browser tab title shown when no project or session is selected. Private to the title helpers. */
const DEFAULT_PAGE_TITLE = 'CloudCLI UI';

/**
 * Resolves the human-readable label for a session: the persisted `summary` (the custom
 * name the sessions API returns for every provider, Cursor included), else the `name` a
 * Cursor session object may carry locally, else the provider's placeholder. Reads the
 * same fields in the same order as the sidebar row, so the header, document title and
 * sidebar never disagree about a session's name.
 */
export const getSessionTitle = (session: ProjectSession): string => {
  const title = (session.summary as string) || (session.name as string);
  if (session.__provider === 'cursor') {
    return title || 'Untitled Session';
  }

  return title || 'New Session';
};

/**
 * Builds the browser tab title for the current selection: the session title when one is
 * open, otherwise the project name, otherwise the app name.
 */
export const getPageTitle = (
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): string => {
  if (selectedSession) {
    return getSessionTitle(selectedSession);
  }

  const displayName = selectedProject?.displayName?.trim();
  return displayName ? `${displayName} - ${DEFAULT_PAGE_TITLE}` : DEFAULT_PAGE_TITLE;
};

// ---------------------------

//----------------- SLASH COMMANDS ------------

/**
 * Whether a slash command is a provider skill (as opposed to a built-in or a
 * custom `.md` command). Skills are mapped with `type: 'skill'`; the metadata
 * check catches entries that only carry the skill marker there. Used wherever
 * commands are grouped or executed differently by kind.
 */
export const isSkillCommand = (command: SlashCommand): boolean =>
  command.type === 'skill' || command.metadata?.type === 'skill';

// ---------------------------

//----------------- QUICK SETTINGS PANEL ------------

/** DOM id of a quick settings tab button; pairs with `getQuickSettingsTabPanelId` for aria-controls / aria-labelledby. */
export const getQuickSettingsTabId = (tab: QuickSettingsTab): string => `quick-settings-tab-${tab}`;

/** DOM id of the tabpanel a quick settings tab controls; pairs with `getQuickSettingsTabId`. */
export const getQuickSettingsTabPanelId = (tab: QuickSettingsTab): string => `quick-settings-tabpanel-${tab}`;
