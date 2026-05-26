export type TriLCEnv = {
  nodeId: string;
  trimcBaseUrl: string;
  openclawGatewayUrl: string;
  vscodiumGlueBaseUrl: string;
};

export function readEnv(): TriLCEnv {
  return {
    nodeId: process.env.TRILC_NODE_ID ?? `node_${process.pid}`,
    trimcBaseUrl: process.env.TRIMC_BASE_URL ?? 'http://127.0.0.1:8710',
    openclawGatewayUrl: process.env.OPENCLOW_GATEWAY_URL ?? 'ws://127.0.0.1:8822',
    vscodiumGlueBaseUrl: process.env.VSCODIUM_GLUE_BASE_URL ?? 'http://127.0.0.1:8730'
  };
}