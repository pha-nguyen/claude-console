import { MONOKAI_COLORS } from '@/shared/constants';

export const getEditorLoadingStyles = (isDarkMode: boolean) => {
  return `
    .code-editor-loading {
      background-color: ${isDarkMode ? MONOKAI_COLORS.background : '#ffffff'} !important;
    }

    .code-editor-loading:hover {
      background-color: ${isDarkMode ? MONOKAI_COLORS.background : '#ffffff'} !important;
    }
  `;
};

export const getEditorStyles = (isDarkMode: boolean) => {
  return `
    .cm-deletedChunk {
      background-color: ${isDarkMode ? `${MONOKAI_COLORS.pink}26` : 'rgba(255, 235, 235, 1)'} !important;
      border-left: 3px solid ${isDarkMode ? `${MONOKAI_COLORS.pink}99` : 'rgb(239, 68, 68)'} !important;
      padding-left: 4px !important;
    }

    .cm-insertedChunk {
      background-color: ${isDarkMode ? `${MONOKAI_COLORS.green}26` : 'rgba(230, 255, 237, 1)'} !important;
      border-left: 3px solid ${isDarkMode ? `${MONOKAI_COLORS.green}99` : 'rgb(34, 197, 94)'} !important;
      padding-left: 4px !important;
    }

    .cm-editor.cm-merge-b .cm-changedText {
      background: ${isDarkMode ? `${MONOKAI_COLORS.green}66` : 'rgba(34, 197, 94, 0.3)'} !important;
      padding-top: 2px !important;
      padding-bottom: 2px !important;
      margin-top: -2px !important;
      margin-bottom: -2px !important;
    }

    .cm-editor .cm-deletedChunk .cm-changedText {
      background: ${isDarkMode ? `${MONOKAI_COLORS.pink}66` : 'rgba(239, 68, 68, 0.3)'} !important;
      padding-top: 2px !important;
      padding-bottom: 2px !important;
      margin-top: -2px !important;
      margin-bottom: -2px !important;
    }

    .cm-gutter.cm-gutter-minimap {
      background-color: ${isDarkMode ? MONOKAI_COLORS.surface : '#f5f5f5'};
    }

    .cm-editor-toolbar-panel {
      padding: 4px 10px;
      background-color: ${isDarkMode ? MONOKAI_COLORS.panel : '#ffffff'};
      border-bottom: 1px solid ${isDarkMode ? MONOKAI_COLORS.border : '#e5e7eb'};
      color: ${isDarkMode ? MONOKAI_COLORS.foreground : '#374151'};
      font-size: 12px;
    }

    .cm-diff-nav-btn,
    .cm-toolbar-btn {
      padding: 3px;
      background: transparent;
      border: none;
      cursor: pointer;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: inherit;
      transition: background-color 0.2s;
    }

    .cm-diff-nav-btn:hover,
    .cm-toolbar-btn:hover {
      background-color: ${isDarkMode ? MONOKAI_COLORS.selection : '#f3f4f6'};
    }

    .cm-diff-nav-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;
};
