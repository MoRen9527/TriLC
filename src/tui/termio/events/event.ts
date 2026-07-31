/**
 * Minimal Event base class — a stripped copy from CC.
 *
 * A级 copy from CC vendor/claude-code-full/src/ink/events/event.ts.
 * Provides stopImmediatePropagation() support used by CC's EventEmitter.
 */
export class Event {
  private _didStopImmediatePropagation = false

  didStopImmediatePropagation(): boolean {
    return this._didStopImmediatePropagation
  }

  stopImmediatePropagation(): void {
    this._didStopImmediatePropagation = true
  }
}
