// ── TriLC Daemon Constants ──
// Shared label and naming constants for OS-level daemon registration.

/** Task name used for schtasks registration on Windows. */
export const TRILC_TASK_NAME = "TriLC Daemon";

/** Task description shown in Windows Task Scheduler. */
export const TRILC_TASK_DESCRIPTION = "TriMetaverse Local Controller — background agent daemon";

/** Label used for macOS launchd plist. */
export const TRILC_LAUNCHD_LABEL = "com.trimetaverse.trilc";

/** Unit name used for Linux systemd user service. */
export const TRILC_SYSTEMD_UNIT = "trilc.service";
