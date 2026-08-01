export type TriLCEnv = {
  nodeId: string;
  port: number;
  trimcBaseUrl: string;
  openclawGatewayUrl: string;
  vscodiumGlueBaseUrl: string;
  /** TriModel configuration-plane API base URL (Phase 1: http://127.0.0.1:3333) */
  trimodelApiUrl: string;
  /** Working directory for local tool execution */
  cwd: string;
  /** Data directory for SQLite event queue and other persistent state */
  dataDir: string;
  /** Agent core version reported in heartbeat */
  version: string;
  /** TriCompany source-agents root (for contract resolver) */
  tricompanySourcePath: string;
  /**
   * Project root directory for multi-project data isolation (Phase 3 pipe3-1).
   * - Project-level data: {projectRoot}/.tricompany-cognition/
   * - Operating records:  {projectRoot}/docs/execution/operating-records/
   * - Defaults to cwd for backward compatibility.
   * - Env: TRILC_PROJECT_ROOT
   */
  projectRoot: string;
};

import { hostname } from 'node:os';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function resolveFromWorkspace(): string {
  // Check env var first
  if (process.env.TRICOMPANY_SOURCE_PATH) return process.env.TRICOMPANY_SOURCE_PATH;

  // Determine the script's own directory (works in both dev and MSI deployment).
  // Using process.cwd() is unreliable: daemon started via RegRun has cwd=C:\Windows\System32.
  const scriptDir = dirname(fileURLToPath(import.meta.url));

  // MSI deployment: contracts/ sits at tools/trilc/contracts/
  // dist/config/env.js → ../../contracts → tools/trilc/contracts/
  const msiContracts = resolve(scriptDir, '..', '..', 'contracts');
  if (existsSync(msiContracts)) return msiContracts;

  // Development workspace: TriCompany/source-agents next to TriLC
  const devContracts = resolve(scriptDir, '..', '..', '..', 'TriCompany', 'source-agents');
  if (existsSync(devContracts)) return devContracts;

  // Last resort: return the development path (will log a warning in contract-resolver)
  return devContracts;
}

export function readEnv(): TriLCEnv {
  const nodeId = process.env.TRILC_NODE_ID ?? `${hostname()}-${process.pid}`;
  const dataDir = process.env.TRILC_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? process.env.HOME ?? '/tmp'}/trilc`;
  const projectRoot = process.env.TRILC_PROJECT_ROOT ?? process.cwd();
  return {
    nodeId,
    port: Number(process.env.TRILC_PORT ?? 8711),
    trimcBaseUrl: process.env.TRIMC_BASE_URL ?? 'http://127.0.0.1:8710',
    openclawGatewayUrl: process.env.OPENCLOW_GATEWAY_URL ?? 'ws://127.0.0.1:8822',
    vscodiumGlueBaseUrl: process.env.VSCODIUM_GLUE_BASE_URL ?? 'http://127.0.0.1:8730',
    trimodelApiUrl: process.env.TRILC_TRIMODEL_API_URL ?? 'http://127.0.0.1:3333',
    cwd: process.env.TRILC_CWD ?? process.cwd(),
    dataDir,
    version: process.env.TRILC_VERSION ?? '0.1.0',
    tricompanySourcePath: process.env.TRICOMPANY_SOURCE_PATH ?? resolveFromWorkspace(),
    projectRoot,
  };
}