// ── Markdown renderer (Ink) ──
// Parses markdown via marked.lexer → recursive token tree → Ink Text/Box components.
// P2-Batch1-#1: diff 渲染 — 解析 tool_result 中的 unified diff 格式，用颜色渲染 +/- 行
import React from 'react';
import { Box, Text } from '../fork.js';
import { lexer } from 'marked';

// marked internally HTML-escapes text tokens (&quot; &amp; &lt; &gt; &#39;).
// Decode them back for terminal rendering.
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

// ── Diff detection and parsing (P2-Batch1-#1) ──
// Detects unified diff format: lines starting with +, -, @@, or space in context
function isDiffContent(content: string): boolean {
  const lines = content.split('\n');
  let diffLineCount = 0;
  // Need at least 3 diff-signature lines to consider it a diff
  for (const line of lines) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) return true;
    if (line.startsWith('@@ ')) return true;
    if (line.startsWith('+') || line.startsWith('-')) diffLineCount++;
  }
  return diffLineCount >= 3;
}

// Parse unified diff into rendered elements
// P2-fix: cap rendered lines to prevent TUI stalls on very large diffs.
const MAX_DIFF_LINES = 200;
function renderDiff(content: string, key: string): React.ReactElement {
  const lines = content.split('\n');
  const truncated = lines.length > MAX_DIFF_LINES;
  const visible = truncated ? lines.slice(0, MAX_DIFF_LINES) : lines;
  const elements: React.ReactElement[] = [];

  for (let i = 0; i < visible.length; i++) {
    const line = visible[i]!;
    const lineKey = `${key}-diff-${i}`;

    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      // File header — dim cyan
      elements.push(React.createElement(Text, { key: lineKey, dimColor: true, color: 'cyan' }, line));
    } else if (line.startsWith('@@ ')) {
      // Hunk header — dim yellow
      elements.push(React.createElement(Text, { key: lineKey, dimColor: true, color: 'yellow' }, line));
    } else if (line.startsWith('+')) {
      // Added line — green
      elements.push(React.createElement(Text, { key: lineKey, color: 'green' }, line));
    } else if (line.startsWith('-')) {
      // Removed line — red
      elements.push(React.createElement(Text, { key: lineKey, color: 'red' }, line));
    } else if (line.startsWith(' ')) {
      // Context line — dim
      elements.push(React.createElement(Text, { key: lineKey, dimColor: true }, line));
    } else {
      // Other lines (e.g., diff headers) — normal dim
      elements.push(React.createElement(Text, { key: lineKey, dimColor: true }, line));
    }
  }

  if (truncated) {
    elements.push(React.createElement(Text, { key: `${key}-diff-trunc`, dimColor: true, italic: true },
      `… ${lines.length - MAX_DIFF_LINES} more lines truncated (diff too large)`));
  }

  return React.createElement(Box, { flexDirection: 'column', marginLeft: 1, key },
    ...elements,
  );
}

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
        return React.createElement(Text, { italic: true, dimColor: true, key: i }, decodeEntities((token.text as string) ?? ''));
      case 'text': {
        // A text token may itself carry nested inline tokens (e.g. inside a
        // strong/em). Flatten them to preserve nested formatting; otherwise
        // render the raw text. Spreads into a single Text node so this branch
        // stays a single ReactElement (keeps flattenInlineTokens return type).
        const childTokens = (token.tokens as Array<Record<string, unknown>> | undefined) ?? [];
        return childTokens.length
          ? React.createElement(Text, { key: i }, ...flattenInlineTokens(childTokens))
          : React.createElement(Text, { key: i }, decodeEntities((token.text as string) ?? ''));
      }
      case 'link':
        // Inline links: display only the link text, dimmed
        return React.createElement(Text, { dimColor: true, key: i }, decodeEntities((token.text as string) ?? ''));
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
    case 'code': {
      const codeText = (token.text as string) ?? '';
      const lang = (token.lang as string) || '';
      const lines = codeText.split('\n');

      // P2-Batch1-#1: Detect diff in code blocks
      if (lang === 'diff' || (lang === '' && isDiffContent(codeText))) {
        return renderDiff(codeText, key);
      }

      return React.createElement(Box, { flexDirection: 'column', marginLeft: 1, key },
        lang ? React.createElement(Text, { dimColor: true, key: `${key}-lang` }, `  ${lang}`) : null,
        ...lines.map((line, li) =>
          React.createElement(Text, { key: `${key}-l${li}` },
            React.createElement(Text, { dimColor: true }, `${String(li + 1).padStart(3)} `),
            React.createElement(Text, { color: 'cyan' }, line),
          ),
        ),
      );
    }
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
      return React.createElement(Text, { dimColor: true, key }, `▎ ${innerText}`);
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
interface MarkdownProps {
  content: string;
  isToolResult?: boolean; // P2-Batch1-#1: 标记是否为 tool_result 内容
}

export default function Markdown({ content, isToolResult }: MarkdownProps) {
  if (!content) return React.createElement(Text, null, '');

  // P2-Batch1-#1: 优先检测 tool_result 中的 diff（tool_result 通常不在 markdown 代码块中）
  if (isToolResult && isDiffContent(content)) {
    return renderDiff(content, 'md-tool-result-diff');
  }

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
