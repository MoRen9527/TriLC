/**
 * Type-safe EventEmitter that respects stopImmediatePropagation.
 *
 * A级 copy from CC vendor/claude-code-full/src/ink/events/emitter.ts.
 * Extends Node's EventEmitter with awareness of our Event class —
 * `emit` respects `stopImmediatePropagation()`.
 */
import { EventEmitter as NodeEventEmitter } from 'events'
import { Event } from './event.js'

export class EventEmitter extends NodeEventEmitter {
  constructor() {
    super()
    // Disable the default maxListeners warning. In React, many components
    // can legitimately listen to the same event (e.g., useInput hooks).
    // The default limit of 10 causes spurious warnings.
    this.setMaxListeners(0)
  }

  override emit(type: string | symbol, ...args: unknown[]): boolean {
    // Delegate to node for `error`, since it's not treated like a normal event
    if (type === 'error') {
      return super.emit(type, ...args)
    }

    const listeners = this.rawListeners(type)

    if (listeners.length === 0) {
      return false
    }

    const ccEvent = args[0] instanceof Event ? args[0] : null

    for (const listener of listeners) {
      listener.apply(this, args)

      if (ccEvent?.didStopImmediatePropagation()) {
        break
      }
    }

    return true
  }
}
