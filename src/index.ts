import { readEnv } from './config/env.js';
import { LocalRuntimeDaemon } from './runtime/daemon.js';

async function main(): Promise<void> {
  const env = readEnv();
  const daemon = new LocalRuntimeDaemon(env);
  await daemon.start();
}

try {
  await main();
} catch (error) {
  console.error('[trilc] failed to start', error);
  throw error;
}