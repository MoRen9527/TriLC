// ── Message Grouping (CC grouping.ts adapted for TriLC) ──
// Groups messages at conversation-turn boundaries: one group per user-assistant exchange.
// Adapted from CC groupMessagesByApiRound for TriLC's simpler Message structure.

export interface TriLCMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function groupMessagesByTurn(messages: TriLCMessage[]): TriLCMessage[][] {
  const groups: TriLCMessage[][] = [];
  let current: TriLCMessage[] = [];

  for (const msg of messages) {
    // Start new group when hitting a user message after an assistant
    if (msg.role === 'user' && current.length > 0 && current.some(m => m.role === 'assistant')) {
      groups.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

// Rough token estimation (4 chars ≈ 1 token)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(messages: TriLCMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}
