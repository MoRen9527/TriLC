// ── TriLC Session Store Types ──
// Defines session persistence model for agent conversation recovery.
// Shared-core candidate: TriMC should adopt same schema for cross-runtime session portability.

export type SessionStatus = 'active' | 'completed' | 'interrupted' | 'expired';

export interface SessionRecord {
  id: string;                    // "sess_{timestamp36}_{random4}"
  status: SessionStatus;
  model: string;
  systemPrompt: string;
  cwd: string;
  messageCount: number;
  createdAt: string;             // ISO 8601
  updatedAt: string;
  closedAt: string | null;
}

export interface SessionMessageRecord {
  id: number;                    // autoincrement
  sessionId: string;
  seq: number;                   // monotonic within session
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  toolCalls: string | null;      // JSON-serialized tool_calls array
  toolCallId: string | null;     // for tool result messages
  reasoningContent: string | null;
  createdAt: string;
}

export interface SessionSummary {
  session: SessionRecord;
  messageCount: number;
  lastUserMessage: string | null;
  hasToolCalls: boolean;
  hasEmptyAssistant: boolean;    // true if any assistant msg lacks both content and tool_calls
}

export interface RecoveryResult {
  ok: boolean;
  session: SessionRecord | null;
  messages: SessionMessageRecord[] | null;
  safetyReport: WorkTreeSafetyReport;
  warnings: string[];
}

export interface WorkTreeSafetyReport {
  cwd: string;
  hasUncommittedChanges: boolean;
  changedFiles: string[];
  typeCheckPassed: boolean | null;  // null if no type checker available
  riskLevel: 'low' | 'medium' | 'high';
}
