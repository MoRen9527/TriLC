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

  // ── Graceful shutdown (Windows + Linux compatible) ──
  // On Windows, SIGTERM from process.kill() maps to TerminateProcess.
  // On Linux, SIGTERM is a standard graceful shutdown signal.
  // The /shutdown POST endpoint provides an alternative for Windows.
  const shutdown = async (signal: string) => {
    console.log(`[trilc] received ${signal}, shutting down gracefully...`);
    try {
      await app.stop();
      await daemon.stop();
      console.log('[trilc] shutdown complete');
    } catch (err) {
      console.error('[trilc] shutdown error:', err instanceof Error ? err.message : String(err));
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  await main();
} catch (error) {
  console.error('[trilc] failed to start', error);
  throw error;
}