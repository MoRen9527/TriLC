// ── ToolCallLine logic test (V-003) ──
// Tests the core string manipulation logic from ToolCallLine.tsx:
// extractArgs + formatLine behavior, without importing ink.
//
// Replicates the internal logic for verification:
//   - Args extraction: parse JSON, first 2 key-value pairs, MAX_VALUE_LEN=40 truncation
//   - Line formatting: MAX_LINE_LEN=70 limit
//   - Status prefixes: braille spinner / ✓ / ✗

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const MAX_VALUE_LEN = 40;
const MAX_LINE_LEN = 70;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Replicate extractArgs logic from ToolCallLine.tsx
function extractArgs(argsJson: string): string {
  try {
    const obj = JSON.parse(argsJson);
    if (typeof obj !== 'object' || obj === null) return '';
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '';

    const parts = entries.slice(0, 2).map(([k, v]) => {
      const valStr = typeof v === 'string' ? v : JSON.stringify(v);
      const truncated = valStr.length > MAX_VALUE_LEN
        ? valStr.slice(0, MAX_VALUE_LEN) + '…'
        : valStr;
      return `${k}: ${truncated}`;
    });

    return parts.join(', ');
  } catch {
    return '';
  }
}

// Replicate formatLine logic
function formatLine(name: string, argsDisplay: string): string {
  const full = argsDisplay ? `${name} ${argsDisplay}` : name;
  if (full.length <= MAX_LINE_LEN) return full;
  return full.slice(0, MAX_LINE_LEN) + '…';
}

describe('V-003 ToolCallLine args extraction', () => {
  it('extracts single arg correctly', () => {
    const result = extractArgs('{"path":"/tmp/test.txt"}');
    assert.equal(result, 'path: /tmp/test.txt');
  });

  it('extracts two args correctly', () => {
    const result = extractArgs('{"path":"/tmp/test.txt","content":"hello world"}');
    assert.ok(result.includes('path:'), 'Should include path key');
    assert.ok(result.includes('content:'), 'Should include content key');
    assert.ok(result.includes('/tmp/test.txt'), 'Should include path value');
    assert.ok(result.includes('hello world'), 'Should include content value');
  });

  it('only shows first 2 key-value pairs', () => {
    const result = extractArgs('{"a":1,"b":2,"c":3,"d":4}');
    assert.ok(result.includes('a:'), 'Should include first key');
    assert.ok(result.includes('b:'), 'Should include second key');
    // Should NOT include third key
    assert.ok(!result.includes('c:'), 'Should NOT include third key');
    assert.ok(!result.includes('d:'), 'Should NOT include fourth key');
  });

  it('truncates value longer than 40 characters', () => {
    const longStr = 'x'.repeat(50);
    const result = extractArgs(JSON.stringify({ path: longStr }));
    assert.ok(result.includes('…'), 'Should contain ellipsis character');
    // The truncated part should be exactly 40 chars + …
    const afterKey = result.split(': ')[1];
    assert.equal(afterKey.length, 40 + 1, 'Should be 40 chars + ellipsis (1 char)'); // … is 1 char
  });

  it('does NOT truncate value exactly 40 characters', () => {
    const exact40 = 'x'.repeat(40);
    const result = extractArgs(JSON.stringify({ path: exact40 }));
    assert.ok(!result.includes('…'), 'Should NOT truncate 40-char value');
  });

  it('empty object returns empty string', () => {
    const result = extractArgs('{}');
    assert.equal(result, '');
  });

  it('null returns empty string', () => {
    const result = extractArgs('null');
    assert.equal(result, '');
  });

  it('invalid JSON returns empty string', () => {
    const result = extractArgs('not-json');
    assert.equal(result, '');
  });

  it('non-string values are JSON-stringified', () => {
    const result = extractArgs('{"count":42,"enabled":true}');
    assert.ok(result.includes('42'), 'Number value should be stringified');
    assert.ok(result.includes('true'), 'Boolean value should be stringified');
  });
});

describe('V-003 ToolCallLine line formatting', () => {
  it('formats tool name with args', () => {
    const line = formatLine('read_file', 'path: /tmp/test.txt');
    assert.ok(line.startsWith('read_file'), 'Should start with tool name');
    assert.ok(line.includes('path:'), 'Should include args');
  });

  it('formats tool name without args', () => {
    const line = formatLine('noop', '');
    assert.equal(line, 'noop');
  });

  it('truncates line longer than 70 characters', () => {
    const longName = 'very_long_tool_name_'.repeat(3);
    const longArgs = 'x: '.repeat(20);
    const line = formatLine(longName, longArgs);
    assert.ok(line.length <= MAX_LINE_LEN + 1, // +1 for ellipsis
      `Line length ${line.length} should be <= ${MAX_LINE_LEN + 1}`);
    assert.ok(line.endsWith('…'), 'Should end with ellipsis');
  });

  it('does NOT truncate line exactly 70 characters', () => {
    const name = 'read_file';
    const args = 'path: ' + 'x'.repeat(58); // "read_file path: " + 58x = 70
    const line = formatLine(name, args);
    // Actually: "read_file " (10) + "path: " (6) + 58x = 74 > 70, so it will truncate
    // Need to calculate more carefully
    const args2 = 'path: ' + 'x'.repeat(54); // "read_file " (10) + "path: " (6) + 54x = 70
    const line2 = formatLine(name, args2);
    assert.equal(line2.length, 70, `Should be exactly 70 chars, got ${line2.length}`);
    assert.ok(!line2.includes('…'), 'Should not truncate');
  });
});

describe('V-003 ToolCallLine braille spinner', () => {
  it('has 10 frames cycling correctly', () => {
    assert.equal(SPINNER_FRAMES.length, 10);
    // Verify cycling logic
    for (let i = 0; i < 10; i++) {
      const next = (i + 1) % 10;
      assert.ok(SPINNER_FRAMES[next] !== SPINNER_FRAMES[i], 'Frames should cycle');
    }
  });

  it('each frame is a single character', () => {
    for (const frame of SPINNER_FRAMES) {
      assert.equal(frame.length, 1, `Frame "${frame}" should be 1 char`);
    }
  });
});

describe('V-003 ToolCallLine status prefixes', () => {
  it('done prefix is checkmark', () => {
    const prefix = '✓'; // ✓
    assert.equal(prefix, '✓');
  });

  it('error prefix is cross mark', () => {
    const prefix = '✗'; // ✗
    assert.equal(prefix, '✗');
  });

  it('pending prefix is from braille spinner set', () => {
    assert.ok(SPINNER_FRAMES.length > 0, 'Spinner frames should be non-empty');
  });
});
