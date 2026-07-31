// ── Frontmatter Parser (CC-equivalent)
// Parses YAML frontmatter from markdown files.
// Supports --- delimiter format.

export interface FrontmatterData {
  [key: string]: unknown;
}

export interface ParsedFrontmatter {
  frontmatter: FrontmatterData;
  content: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Supports --- delimiter format.
 */
export function parseFrontmatter(
  markdown: string,
  _filePath?: string,
): ParsedFrontmatter {
  const content = markdown;
  const frontmatter: FrontmatterData = {};

  // Check for frontmatter delimiter
  if (!content.startsWith('---')) {
    return { frontmatter, content };
  }

  // Find end delimiter
  const endIdx = content.indexOf('\n---\n', 3);
  if (endIdx === -1) {
    return { frontmatter, content };
  }

  // Extract frontmatter lines
  const frontmatterText = content.slice(3, endIdx).trim();
  const bodyContent = content.slice(endIdx + 5);

  // Parse simple YAML (key: value format)
  for (const line of frontmatterText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const valueStr = trimmed.slice(colonIdx + 1).trim();

    // Simple value parsing
    frontmatter[key] = parseYamlValue(valueStr);
  }

  return { frontmatter, content: bodyContent };
}

/**
 * Parse a simple YAML value (strings, numbers, booleans, arrays).
 */
function parseYamlValue(valueStr: string): unknown {
  // Remove quotes if present
  if ((valueStr.startsWith('"') && valueStr.endsWith('"')) ||
      (valueStr.startsWith("'") && valueStr.endsWith("'"))) {
    return valueStr.slice(1, -1);
  }

  // Boolean
  if (valueStr === 'true') return true;
  if (valueStr === 'false') return false;

  // Number
  if (/^-?\d+$/.test(valueStr)) return parseInt(valueStr, 10);
  if (/^-?\d+\.\d+$/.test(valueStr)) return parseFloat(valueStr);

  // Array (comma-separated)
  if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
    const inner = valueStr.slice(1, -1);
    if (!inner.trim()) return [];
    return inner.split(',').map((s) => parseYamlValue(s.trim()));
  }

  // Default: string
  return valueStr;
}
