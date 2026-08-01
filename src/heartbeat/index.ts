// ── TriLC Heartbeat Barrel ──
// Re-exports heartbeat module primitives for consumers (daemon, CLI, tests).

export { createHeartbeatWake, type TriLCHeartbeatWake, type HeartbeatRunResult, type HeartbeatWakeHandler } from "./heartbeat-wake.js";
export { createHeartbeatRunner, type TriLCHeartbeatRunner, type HeartbeatAgentConfig } from "./heartbeat-runner.js";
export { runHeartbeatAgent, type RunHeartbeatAgentOpts } from "./agent-runner.js";
