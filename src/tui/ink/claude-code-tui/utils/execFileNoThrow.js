// Minimal execFileNoThrow — used by the ink terminal layer for queries
// (XTVERSION etc.). Returns trimmed stdout, or '' on any failure.
import { execFileSync } from 'child_process';
export const execFileNoThrow = (file, args, timeoutMs) => {
    try {
        return (execFileSync(file, args ?? [], {
            encoding: 'utf8',
            timeout: timeoutMs ?? 2000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
        })?.trim() ?? '');
    }
    catch {
        return '';
    }
};
