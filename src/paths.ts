// ── Shared runtime paths (REQ-018) ──
// Single source of truth for the daemon-owned PID file location.
// Both the CLI (manager side) and the daemon process (owner side) import
// from here — previously the constant was duplicated in cli.ts and
// hardcoded again in daemon/schtasks.ts, while the daemon itself had no
// knowledge of its own PID file.
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// TRILC_PID_DIR override exists for test isolation (integration tests must
// not touch the real user PID file) and mirrors TRILC_DATA_DIR conventions.
export const PID_DIR = process.env.TRILC_PID_DIR ?? resolve(homedir(), '.trimetaverse');
export const PID_FILE = resolve(PID_DIR, 'trilc.pid');
