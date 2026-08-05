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
    // REQ-20260805-004: collect tool events (tool_call/tool_result) so the
    // agent's tool feedback is visible in the session and downstream consumers.
    const toolMessages: Array<{
      role: "tool";
      content: string;
      toolCallId: string;
      isError?: boolean;
    }> = [];
    let toolBlockedCount = 0;

    for await (const event of agentLoop({
      model,
      systemPrompt: prompt,
      messages: [{ role: "user", content: message }],
      maxTurns,
      // REQ-20260805-006: 'heartbeat' tier = read + write allowed, no shell.
      tier: "heartbeat",
      cwd,
    })) {
      if (event.type === "content_delta") {
        content += event.delta;
      } else if (event.type === "assistant_message" && event.content) {
        if (!content) content = event.content;
      } else if (event.type === "tool_result") {
        toolMessages.push({
          role: "tool",
          content: event.content,
          toolCallId: event.tool_call_id,
          isError: event.is_error,
        });
      } else if (event.type === "tool_blocked") {
        toolBlockedCount++;
        toolMessages.push({
          role: "tool",
          content: `[blocked] ${event.tool_name}: ${event.reason}`,
          toolCallId: `blocked_${toolBlockedCount}`,
          isError: true,
        });
      }
    }

    // Persist the full conversation (user → tool results → assistant)
    const persistMessages: Array<{
      role: "user" | "assistant" | "tool";
      content: string | null;
      toolCallId?: string;
    }> = [{ role: "user", content: message }];
    for (const tm of toolMessages) {
      persistMessages.push({ role: "tool", content: tm.content, toolCallId: tm.toolCallId });
    }
    persistMessages.push({ role: "assistant", content: content || "Heartbeat completed" });
    sessionStore.saveMessages(sessionId, persistMessages);
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
