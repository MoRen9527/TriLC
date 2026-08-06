// ── REQ-018 integration fixture ──
// Mimics the daemon's PID lifecycle contract exactly as src/index.ts does:
//   register PID after the HTTP server is listening,
//   unregister on graceful shutdown (/shutdown endpoint).
// Uses the same pidfile.ts primitives as the real daemon, so the test
// exercises the real registration/unregistration code paths.
import { createServer } from 'node:http';
import { registerPid, unregisterPid } from '../../src/pidfile.js';

const port = parseInt(process.env.TEST_PORT ?? '18711', 10);

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/shutdown') {
    res.end('ok');
    void (async () => {
      await unregisterPid();
      server.close(() => process.exit(0));
      // safety net: force-exit if close hangs
      setTimeout(() => process.exit(0), 2000).unref();
    })();
    return;
  }
  res.end('{}');
});

server.listen(port, '127.0.0.1', async () => {
  try {
    await registerPid();
    console.log('PID-REGISTERED');
  } catch (err) {
    console.error('PID-REGISTER-FAILED', err);
    process.exit(1);
  }
});

// POSIX graceful-signal fallback (Windows maps SIGTERM to TerminateProcess).
process.on('SIGTERM', () => {
  console.log('SIGNAL-SIGTERM');
  void (async () => {
    await unregisterPid();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  })();
});
process.on('SIGINT', () => {
  console.log('SIGNAL-SIGINT');
  void (async () => {
    await unregisterPid();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  })();
});
