// ── TriLC Localbus ──
// In-process typed EventEmitter bus for local module decoupling.
// Phase 1: EventEmitter memory bus (CTO-008-M §3.4.2).
// Phase 2: upgrade to Unix Domain Socket / Named Pipe.

import { EventEmitter } from 'node:events';

export type LocalBusEvent =
  | { type: 'task:queued'; taskId: string }
  | { type: 'task:running'; taskId: string }
  | { type: 'task:succeeded'; taskId: string; result: unknown }
  | { type: 'task:failed'; taskId: string; error: string }
  | { type: 'task:cancelled'; taskId: string }           // ← S7 新增
  | { type: 'node:connected' }
  | { type: 'node:degraded' }
  | { type: 'node:local' }
  | { type: 'agent:event'; event: Record<string, unknown> };

// Singleton shared by daemon, planner, and event-queue
export const localBus = new EventEmitter<{ event: [LocalBusEvent] }>();

// Fire-and-forget publish helper
export function publish(event: LocalBusEvent): void {
  localBus.emit('event', event);
}
