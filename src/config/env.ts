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
};

import { hostname } from 'node:os';
import { resolve } from 'node:path';

function resolveFromWorkspace(): string {
  // Auto-discover TriCompany from TriLC's workspace
  return process.env.TRICOMPANY_SOURCE_PATH ?? resolve(process.cwd(), '..', 'TriCompany', '.github', 'source-agents');
}

export function readEnv(): TriLCEnv {
  const nodeId = process.env.TRILC_NODE_ID ?? `${hostname()}-${process.pid}`;
  const dataDir = process.env.TRILC_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? process.env.HOME ?? '/tmp'}/trilc`;
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
  };
}