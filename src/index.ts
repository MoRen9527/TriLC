import { readEnv } from './config/env.js';
import { LocalRuntimeDaemon } from './runtime/daemon.js';
import { createTriLCApp } from './server/app.js';

async function main(): Promise<void> {
  const env = readEnv();

  // Start local runtime daemon (heartbeat, node registration)
  const daemon = new LocalRuntimeDaemon(env);
  await daemon.start();

  // Start HTTP server for TriPilot/TriCode connectivity
  const app = createTriLCApp(env);
  await app.start();

  console.log(`[trilc] ready — node=${env.nodeId} port=${app.port}`);
}

try {
  await main();
} catch (error) {
  console.error('[trilc] failed to start', error);
  throw error;
}