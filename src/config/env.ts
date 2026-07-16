export type TriLCEnv = {
  nodeId: string;
  port: number;
  trimcBaseUrl: string;
  openclawGatewayUrl: string;
  vscodiumGlueBaseUrl: string;
  /** Working directory for local tool execution */
  cwd: string;
  /** Data directory for SQLite event queue and other persistent state */
  dataDir: string;
  /** Agent core version reported in heartbeat */
  version: string;
};

import { hostname } from 'node:os';

export function readEnv(): TriLCEnv {
  const nodeId = process.env.TRILC_NODE_ID ?? `${hostname()}-${process.pid}`;
  return {
    nodeId,
    port: Number(process.env.TRILC_PORT ?? 8711),
    trimcBaseUrl: process.env.TRIMC_BASE_URL ?? 'http://127.0.0.1:8710',
    openclawGatewayUrl: process.env.OPENCLOW_GATEWAY_URL ?? 'ws://127.0.0.1:8822',
    vscodiumGlueBaseUrl: process.env.VSCODIUM_GLUE_BASE_URL ?? 'http://127.0.0.1:8730',
    cwd: process.env.TRILC_CWD ?? process.cwd(),
    dataDir: process.env.TRILC_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? process.env.HOME ?? '/tmp'}/trilc`,
    version: process.env.TRILC_VERSION ?? '0.1.0',
  };
}