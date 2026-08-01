// ── TriLC Agent Runner ──
// Default heartbeat agent execution: runOnce → agentLoop → persistence.
// MVP: single model, tier 'subagent' (heartbeat-equivalent), session-store persistence.
//
// Called by HeartbeatRunner for each due agent. Runs a single agentLoop
// cycle and persists the result to session-store for recovery and audit.

import { agentLoop } from "@trimetaverse/agent-core";
import type { HeartbeatRunResult } from "./heartbeat-wake.js";
import type { SessionRecord } from "../session-store/types.js";

export interface RunHeartbeatAgentOpts {
  agentId: string;
  sessionStore: {
    createSession(session: {
      id: string;
      model: string;
      systemPrompt: string;
      cwd: string;
      title?: string;
    }): void;
    saveMessages(
      sessionId: string,
      messages: Array<{
        role: "user" | "assistant" | "system" | "tool";
        content: string | null;
        toolCalls?: unknown;
        toolCallId?: string;
        reasoningContent?: string;
      }>,
    ): void;
    updateSessionStatus(sessionId: string, status: SessionRecord["status"]): void;
  };
  cwd: string;
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  userMessage?: string;
}

export async function runHeartbeatAgent(
  opts: RunHeartbeatAgentOpts,
): Promise<HeartbeatRunResult> {
  const {
    agentId,
    sessionStore,
    cwd,
    model = "deepseek-v4-flash",
    maxTurns = 10,
    systemPrompt,
    userMessage,
  } = opts;

  const startTime = Date.now();
  const sessionId = `hb_${agentId}_${startTime.toString(36)}`;

  const prompt = systemPrompt ??
    `You are heartbeat agent "${agentId}". Execute your periodic task concisely.`;
  const message = userMessage ??
    `Heartbeat check for ${agentId}. Report status.`;

  try {
    // Create session for traceability
    sessionStore.createSession({
      id: sessionId,
      model,
      systemPrompt: prompt,
      cwd,
    });

    let content = "";

    for await (const event of agentLoop({
      model,
      systemPrompt: prompt,
      messages: [{ role: "user", content: message }],
      maxTurns,
      // tier 'heartbeat' is not yet in the AgentTier union; use 'subagent'
      // as it provides the appropriate restricted permission set.
      tier: "subagent",
      cwd,
    })) {
      if (event.type === "content_delta") {
        content += event.delta;
      } else if (event.type === "assistant_message" && event.content) {
        if (!content) content = event.content;
      }
    }

    // Persist the full conversation
    sessionStore.saveMessages(sessionId, [
      { role: "user", content: message },
      { role: "assistant", content: content || "Heartbeat completed" },
    ]);
    sessionStore.updateSessionStatus(sessionId, "completed");

    const durationMs = Date.now() - startTime;
    console.log(
      `[trilc:heartbeat] agent=${agentId} completed in ${durationMs}ms`,
    );
    return { status: "ran", durationMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[trilc:heartbeat] agent ${agentId} failed:`, msg);

    try {
      sessionStore.updateSessionStatus(sessionId, "interrupted");
    } catch {
      // Best-effort status update
    }

    return { status: "failed", reason: msg };
  }
}
