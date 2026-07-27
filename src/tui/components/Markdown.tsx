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
      case 'text': {
        // A text token may itself carry nested inline tokens (e.g. inside a
        // strong/em). Flatten them to preserve nested formatting; otherwise
        // render the raw text. Spreads into a single Text node so this branch
        // stays a single ReactElement (keeps flattenInlineTokens return type).
        const childTokens = (token.tokens as Array<Record<string, unknown>> | undefined) ?? [];
        return childTokens.length
          ? React.createElement(Text, { key: i }, ...flattenInlineTokens(childTokens))
          : React.createElement(Text, { key: i }, (token.text as string) ?? '');
      }
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
    case 'table': {
      const header = (token.header as Array<Record<string, unknown>>) ?? [];
      const rows = (token.rows as Array<Array<Record<string, unknown>>>) ?? [];
      const align = (token.align as Array<string | null>) ?? [];
      const colCount = header.length;
      if (colCount === 0) return null;

      // Column width = max cell text length across header + every data row
      const cellText = (cell: Record<string, unknown> | undefined): string =>
        (cell?.text as string) ?? '';
      const widths: number[] = new Array(colCount).fill(0);
      const measure = (row: Array<Record<string, unknown>>) => {
        for (let c = 0; c < row.length && c < colCount; c++) {
          const len = cellText(row[c]).length;
          if (len > widths[c]) widths[c] = len;
        }
      };
      measure(header);
      rows.forEach(measure);

      // MVP alignment: right → padStart, everything else → padEnd (no center/wrap)
      const formatRow = (row: Array<Record<string, unknown>>): string =>
        '| ' + row.map((cell, c) => {
          const text = cellText(cell);
          return align[c] === 'right' ? text.padStart(widths[c]) : text.padEnd(widths[c]);
        }).join(' | ') + ' |';
      const separator = '| ' + widths.map((w) => '─'.repeat(w)).join(' | ') + ' |';

      return React.createElement(
        Box,
        { flexDirection: 'column', key },
        React.createElement(Text, { bold: true, key: 'th' }, formatRow(header)),
        React.createElement(Text, { dimColor: true, key: 'sep' }, separator),
        ...rows.map((row, r) => React.createElement(Text, { key: `tr-${r}` }, formatRow(row))),
      );
    }
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
