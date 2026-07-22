// ── TriLC Mirror Types ──
// S7: TriLC-side mirror types (compatible with TriMC MirrorRequest).
// CPO Q6c + CTO §7.2 S7 §3.5.

/** TriLC 侧 mirror 任务快照（不包含 TriMC 服务端字段） */
export interface MirrorTaskSnapshot {
  taskId: string;
  title: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  summary: string;
  updatedAt: string;
}
