import { useEffect, useId, useState } from 'react';
// Type-only: erased at build time, so it does not pull mermaid into the main chunk.
import type mermaid from 'mermaid';

import { useTheme } from '@/shared/context/ThemeContext';
import { MONOKAI_COLORS } from '@/shared/constants';

// Mermaid is ~1.5MB minified, so it is loaded on demand the first time a
// diagram is rendered and shared by every instance afterwards.
let mermaidPromise: Promise<typeof mermaid> | null = null;
const loadMermaid = () => {
  mermaidPromise ??= import('mermaid').then((module) => module.default);
  return mermaidPromise;
};

type MermaidDiagramProps = {
  /** Raw mermaid source, i.e. the body of a ```mermaid fenced block. */
  code: string;
};

/**
 * Renders a ```mermaid code block as an SVG diagram, GitHub-preview style.
 *
 * Used by the chat module to render mermaid blocks in assistant messages, and
 * by MarkdownCodeBlock inside code-editor for markdown previews.
 *
 * While mermaid is loading — or when the source doesn't parse (e.g. a block
 * that is still streaming in) — the raw source is shown instead, so the
 * content is never blank or replaced by an error box.
 */
export default function MermaidDiagram({ code }: MermaidDiagramProps) {
  const { isDarkMode } = useTheme();
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;

    loadMermaid()
      .then((mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDarkMode ? 'base' : 'default',
          themeVariables: isDarkMode ? {
            darkMode: true,
            background: MONOKAI_COLORS.background,
            primaryColor: MONOKAI_COLORS.panel,
            primaryTextColor: MONOKAI_COLORS.foreground,
            primaryBorderColor: MONOKAI_COLORS.green,
            secondaryColor: MONOKAI_COLORS.selection,
            secondaryTextColor: MONOKAI_COLORS.foreground,
            secondaryBorderColor: MONOKAI_COLORS.cyan,
            tertiaryColor: MONOKAI_COLORS.surface,
            tertiaryTextColor: MONOKAI_COLORS.foreground,
            tertiaryBorderColor: MONOKAI_COLORS.purple,
            lineColor: MONOKAI_COLORS.cyan,
            textColor: MONOKAI_COLORS.foreground,
            edgeLabelBackground: MONOKAI_COLORS.background,
            fontFamily: '"Encode Sans", system-ui, sans-serif',
          } : {},
          suppressErrorRendering: true,
        });
        return mermaid.render(renderId, code.trim());
      })
      .then((result) => {
        if (!cancelled) {
          setSvg(result.svg);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSvg(null);
        }
        // suppressErrorRendering still leaves the scratch element behind on
        // parse failures in some mermaid versions; clean it up.
        document.getElementById(`d${renderId}`)?.remove();
      });

    return () => {
      cancelled = true;
    };
  }, [code, isDarkMode, reactId]);

  if (!svg) {
    return (
      <pre className="my-3 overflow-x-auto rounded-xl border border-border bg-muted/50 p-4 font-mono text-[0.8125rem] leading-relaxed text-muted-foreground dark:bg-zinc-900">
        {code.trim()}
      </pre>
    );
  }

  return (
    <div
      className="my-3 flex justify-center overflow-x-auto rounded-xl border border-border bg-white p-4 dark:bg-zinc-900 [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
