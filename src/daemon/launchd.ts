// ── TriLC Daemon — macOS launchd ──
// @platform-deferred
// Phase 3: macOS launchd plist registration and lifecycle management.
// Target: W34 (2026-08-21).
//
// Pattern reference: vendor/openclaw/src/daemon/launchd.ts
//
// Acceptance checklist (Phase 3):
// [ ] plist file staged at ~/Library/LaunchAgents/com.trimetaverse.trilc.plist
// [ ] plist contains correct ProgramArguments, WorkingDirectory, EnvironmentVariables
// [ ] launchctl load ~/Library/LaunchAgents/com.trimetaverse.trilc.plist succeeds
// [ ] launchctl start com.trimetaverse.trilc starts the daemon
// [ ] launchctl stop com.trimetaverse.trilc stops the daemon
// [ ] launchctl unload removes the service
// [ ] RunAtLoad: true => daemon auto-starts on login
// [ ] KeepAlive: true => daemon restarts on crash
// [ ] StandardOutPath / StandardErrorPath point to TriLC data dir
// [ ] isLoaded() returns correct state via launchctl list
// [ ] readTaskRuntime() detects running PID via launchctl list + kill -0
// [ ] status() returns correct DaemonServiceState with runtime/pid/uptime
// [ ] restart() correctly stops + starts the service
// [ ] Tested on macOS 14+ (Sonoma) and 15+ (Sequoia)

import type { TriLCDaemonService, TriLCDaemonServiceConfig, DaemonServiceState, DaemonServiceStartResult } from "./service.js";

function throwPlatformDeferred(): never {
  throw new Error("[trilc:daemon] macOS launchd support is @platform-deferred (Phase 3, W34)");
}

export function createLaunchdService(): TriLCDaemonService {
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
