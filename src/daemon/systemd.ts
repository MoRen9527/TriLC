// ── TriLC Daemon — Linux systemd ──
// @platform-deferred
// Phase 3: Linux systemd user unit registration and lifecycle management.
// Target: W34 (2026-08-21).
//
// Pattern reference: vendor/openclaw/src/daemon/systemd.ts
//
// Acceptance checklist (Phase 3):
// [ ] unit file staged at ~/.config/systemd/user/trilc.service
// [ ] unit file contains correct ExecStart, WorkingDirectory, Environment entries
// [ ] systemctl --user daemon-reload picks up new unit
// [ ] systemctl --user start trilc.service starts the daemon
// [ ] systemctl --user stop trilc.service stops the daemon
// [ ] systemctl --user enable trilc.service for auto-start on login
// [ ] systemctl --user disable trilc.service removes auto-start
// [ ] systemctl --user status trilc.service shows correct ActiveState/SubState
// [ ] StandardOutput/StandardError journal (default) or file path
// [ ] Restart=on-failure keeps daemon running after crash
// [ ] RestartSec=5s prevents rapid restart loops
// [ ] isLoaded() checks systemctl --user is-enabled
// [ ] readTaskRuntime() detects running PID via systemctl --user show -p MainPID
// [ ] status() returns correct DaemonServiceState with runtime/pid/uptime
// [ ] restart() correctly stops + starts the service
// [ ] Tested on Ubuntu 24.04+ LTS and Fedora 40+
// [ ] Works with user-scoped systemd (no root/sudo required)

import type { TriLCDaemonService, TriLCDaemonServiceConfig, DaemonServiceState, DaemonServiceStartResult } from "./service.js";

function throwPlatformDeferred(): never {
  throw new Error("[trilc:daemon] Linux systemd support is @platform-deferred (Phase 3, W34)");
}

export function createSystemdService(): TriLCDaemonService {
  return {
    async stage(_config: TriLCDaemonServiceConfig): Promise<string> {
      throwPlatformDeferred();
    },
    async install(_config: TriLCDaemonServiceConfig): Promise<void> {
      throwPlatformDeferred();
    },
    async uninstall(_config: TriLCDaemonServiceConfig): Promise<void> {
      throwPlatformDeferred();
    },
    async stop(_config: TriLCDaemonServiceConfig): Promise<void> {
      throwPlatformDeferred();
    },
    async restart(_config: TriLCDaemonServiceConfig): Promise<DaemonServiceStartResult> {
      throwPlatformDeferred();
    },
    async status(_config: TriLCDaemonServiceConfig): Promise<DaemonServiceState> {
      throwPlatformDeferred();
    },
    async isLoaded(_config: TriLCDaemonServiceConfig): Promise<boolean> {
      throwPlatformDeferred();
    },
  };
}
