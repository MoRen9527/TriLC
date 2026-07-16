export type LocalTaskState = 'queued' | 'running' | 'succeeded' | 'failed';

export class TaskRuntime {
  private state: LocalTaskState = 'queued';
  private startedAt: number | null = null;
  private completedAt: number | null = null;

  markRunning(): void {
    this.state = 'running';
    this.startedAt = Date.now();
  }

  markSucceeded(): void {
    this.state = 'succeeded';
    this.completedAt = Date.now();
  }

  markFailed(): void {
    this.state = 'failed';
    this.completedAt = Date.now();
  }

  getState(): LocalTaskState {
    return this.state;
  }

  get durationMs(): number | null {
    if (this.startedAt === null) return null;
    return (this.completedAt ?? Date.now()) - this.startedAt;
  }
}