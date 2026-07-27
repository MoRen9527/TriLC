// ── TriLC Edit tool ──
// CC-equivalent string-replacement editor. Supports replace_all and
// exact-match semantics (old_string must appear verbatim in file).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { register as registerTool } from '@trimetaverse/agent-core';

export function registerEditTool(): void {
  registerTool(
    {
      type: 'function',
      function: {
        name: 'Edit',
        description:
          'Performs exact string replacements in a file.\n' +
          'Usage:\n' +
          '- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.\n' +
          '- ALWAYS prefer editing existing files. NEVER write new files unless explicitly required.\n' +
          '- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n' +
          '- The edit will FAIL if old_string is not unique in the file.\n' +
          '  * Either provide a larger string with more surrounding context to make it unique.\n' +
          '  * Or set replace_all to true to replace every occurrence of old_string.',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The absolute path to the file to modify',
            },
            old_string: {
              type: 'string',
              description: 'The text to replace',
            },
            new_string: {
              type: 'string',
              description: 'The text to replace it with (must be different from old_string)',
            },
            replace_all: {
              type: 'boolean',
              description: 'Replace all occurrences of old_string (default false)',
            },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    },
    async (args: Record<string, unknown>) => {
      const filePath = args.file_path as string;
      const oldString = args.old_string as string;
      const newString = args.new_string as string;
      const replaceAll = args.replace_all === true;

      if (!filePath) return JSON.stringify({ error: 'file_path is required' });
      if (oldString === undefined || oldString === null) return JSON.stringify({ error: 'old_string is required' });

      const absolutePath = isAbsolute(filePath)
        ? filePath
        : resolve(process.cwd(), filePath);

      try {
        // Read existing file
        let originalContent: string;
        try {
          originalContent = readFileSync(absolutePath, 'utf-8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return JSON.stringify({
              error: `File does not exist: ${filePath}`,
              file_path: filePath,
            });
          }
          throw e;
        }

        if (oldString === newString) {
          return JSON.stringify({
            error: 'No changes to make: old_string and new_string are exactly the same.',
            file_path: filePath,
          });
        }

        // Count matches
        const occurrences = originalContent.split(oldString).length - 1;

        if (occurrences === 0) {
          return JSON.stringify({
            error: `String to replace not found in file.\nString: ${oldString.slice(0, 200)}`,
            file_path: filePath,
          });
        }

        if (occurrences > 1 && !replaceAll) {
          return JSON.stringify({
            error: `Found ${occurrences} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString.slice(0, 200)}`,
            file_path: filePath,
          });
        }

        // Perform replacement
        let updatedContent: string;
        if (replaceAll) {
          updatedContent = originalContent.split(oldString).join(newString);
        } else {
          updatedContent = originalContent.replace(oldString, newString);
        }

        // Ensure parent directory exists
        mkdirSync(dirname(absolutePath), { recursive: true });

        // Write back
        writeFileSync(absolutePath, updatedContent, 'utf-8');

        return JSON.stringify({
          file_path: filePath,
          message: replaceAll
            ? `The file ${filePath} has been updated. All ${occurrences} occurrences were successfully replaced.`
            : `The file ${filePath} has been updated successfully.`,
          occurrences_replaced: replaceAll ? occurrences : 1,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: msg, file_path: filePath });
      }
    },
  );
}
