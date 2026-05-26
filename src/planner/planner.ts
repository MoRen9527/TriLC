export class LocalPlanner {
  createPlan(taskType: string): string[] {
    return [`analyze:${taskType}`, 'execute', 'collect-artifacts'];
  }
}