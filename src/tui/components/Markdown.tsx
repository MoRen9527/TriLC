// ── Markdown renderer (Ink) ──
// Parses markdown via marked.lexer → recursive token tree → Ink Text/Box components.
import React from 'react';
import { Box, Text } from 'ink';
import { lexer } from 'marked';

// ── Inline token flattening ──
// Recursively flatten nested inline tokens (strong, em, codespan, text, link, del)
// into a flat array of Ink Text elements.
function flattenInlineTokens(tokens: Array<Record<string, unknown>>): React.ReactElement[] {
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'strong':
        return React.createElement(Text, { bold: true, key: i },
          ...flattenInlineTokens((token.tokens as Array<Record<string, unknown>>) ?? []));
      case 'em':
        return React.createElement(Text, { italic: true, key: i },
          ...flattenInlineTokens((token.tokens as Array<Record<string, unknown>>) ?? []));
      case 'codespan':
        return React.createElement(Text, { italic: true, dimColor: true, key: i }, (token.text as string) ?? '');
      case 'text':
        return React.createElement(Text, { key: i }, (token.text as string) ?? '');
      case 'link':
        // Inline links: display only the link text, dimmed
        return React.createElement(Text, { dimColor: true, key: i }, (token.text as string) ?? '');
      case 'del':
        return React.createElement(Text, { strikethrough: true, key: i },
          ...flattenInlineTokens((token.tokens as Array<Record<string, unknown>>) ?? []));
      default:
        // Fallback: render any unknown inline token's text
        if (token.text) return React.createElement(Text, { key: i }, token.text as string);
        return React.createElement(Text, { key: i }, '');
    }
  });
}

// ── Block token rendering ──
// Maps each top-level block token to an Ink element.
function renderBlockToken(
  token: Record<string, unknown>,
  key: string,
): React.ReactElement | null {
  switch (token.type) {
    case 'heading': {
      const depth = token.depth as number;
      if (depth > 3) {
        // Depths > 3 render as bold text without inline children
        return React.createElement(Text, { bold: true, key }, (token.text as string) ?? '');
      }
      return React.createElement(Text, { bold: true, key },
        ...flattenInlineTokens((token.tokens as Array<Record<string, unknown>>) ?? []));
    }
    case 'paragraph':
      return React.createElement(Text, { key },
        ...flattenInlineTokens((token.tokens as Array<Record<string, unknown>>) ?? []));
    case 'code':
      return React.createElement(Text, { dimColor: true, key }, (token.text as string) ?? '');
    case 'list': {
      const items = (token.items as Array<Record<string, unknown>>) ?? [];
      const ordered = token.ordered as boolean;
      const start = (token.start as number) || 1;
      return React.createElement(Box, { flexDirection: 'column', marginLeft: 2, key },
        ...items.map((item, j) => {
          const prefix = ordered ? `${start + j}. ` : '• ';
          return React.createElement(Text, { key: j },
            prefix,
            ...flattenInlineTokens((item.tokens as Array<Record<string, unknown>>) ?? []));
        }),
      );
    }
    case 'list_item':
      // Standalone list_item (rare; normally consumed inside list handler)
      return React.createElement(Text, { key },
        ...flattenInlineTokens((token.tokens as Array<Record<string, unknown>>) ?? []));
    case 'blockquote': {
      const innerText = ((token.tokens as Array<Record<string, unknown>>) ?? [])
        .map((t: Record<string, unknown>) => (t.text as string) ?? (t.raw as string) ?? '')
        .join(' ');
      return React.createElement(Text, { dimColor: true, key }, `│ ${innerText}`);
    }
    case 'hr':
      return React.createElement(Text, { dimColor: true, key }, '───');
    case 'space':
      return React.createElement(Text, { key }, ' ');
    default:
      return null;
  }
}

// ── Component ──
export default function Markdown({ content }: { content: string }) {
  if (!content) return React.createElement(Text, null, '');

  try {
    const tokens = lexer(content);
    const children = (tokens as Array<Record<string, unknown>>)
      .map((token, i) => renderBlockToken(token, `md-${i}`))
      .filter((el): el is React.ReactElement => el !== null);

    return React.createElement(Box, { flexDirection: 'column' }, ...children);
  } catch {
    // Graceful fallback: render raw content on parse failure
    return React.createElement(Text, null, content);
  }
}
