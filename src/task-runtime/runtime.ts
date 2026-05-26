export type LocalTaskState = 'queued' | 'running' | 'succeeded' | 'failed';

export class TaskRuntime {
  private state: LocalTaskState = 'queued';

  markRunning(): void {
    this.state = 'running';
  }

  getState(): LocalTaskState {
    return this.state;
  }
}