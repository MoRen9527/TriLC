/**
 * InputPipeline -- CC stdin management extracted from App.tsx
 *
 * Excerpted from CC:
 * handleReadable + processInput + flushIncomplete + processKeysInBatch.
 * Removed: mouse/selection/hyperlinks, terminal querier, focus events,
 *          Ctrl+Z SUSPEND, DOM dispatch, bracketed paste.
 */

import { EventEmitter } from './events/emitter.js'
import { InputEvent } from './events/input-event.js'
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type KeyParseState,
  type ParsedInput,
} from './parse-keypress.js'

export class InputPipeline {
  private emitter_ = new EventEmitter()
  private keyParseState: KeyParseState = { ...INITIAL_STATE }
  private incompleteTimer: ReturnType<typeof setTimeout> | null = null
  private readonly NORMAL_TIMEOUT = 50
  private readonly PASTE_TIMEOUT = 500
  private stdin: NodeJS.ReadStream
  private rawModeCount = 0
  private running = false

  constructor(stdin: NodeJS.ReadStream) {
    this.stdin = stdin
  }

  get emitter(): EventEmitter {
    return this.emitter_
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.stdin.setEncoding('utf8')
    if (this.rawModeCount === 0) {
      this.stdin.setRawMode(true as any)
      // suppress TS: setRawMode expects boolean arg
      this.stdin.addListener('readable', this.handleReadable)
    }
    this.rawModeCount++
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    if (--this.rawModeCount === 0) {
      this.stdin.removeListener('readable', this.handleReadable)
      this.stdin.setRawMode(false as any)
    }
    // NOTE: do NOT removeAllListeners here. stop() is driven by the
    // raw-mode refcount (useInput's setRawMode(false) on blur/teardown),
    // and removing listeners kills every 'input' subscription while the
    // subscribing useEffects' deps are stable and never re-run — the
    // keyboard stays dead. Full listener/timer teardown lives in dispose().
  }

  dispose(): void {
    this.emitter_.removeAllListeners()
    if (this.incompleteTimer) {
      clearTimeout(this.incompleteTimer)
      this.incompleteTimer = null
    }
  }

  reset(): void {
    this.keyParseState = { ...INITIAL_STATE }
    if (this.incompleteTimer) {
      clearTimeout(this.incompleteTimer)
      this.incompleteTimer = null
    }
  }

  private handleReadable = (): void => {
    try {
      let chunk: string | null
      while ((chunk = this.stdin.read() as string | null) !== null) {
        this.processInput(chunk)
      }
    } catch (_err) {
      if (
        this.running &&
        !this.stdin.listeners('readable').includes(this.handleReadable)
      ) {
        this.stdin.addListener('readable', this.handleReadable)
      }
    }
  }

  private processInput(input: string | null): void {
    const [keys, newState] = parseMultipleKeypresses(this.keyParseState, input)
    this.keyParseState = newState

    if (keys.length > 0) {
      processKeysInBatch(this.emitter_, keys)
    }

    if (this.keyParseState.incomplete) {
      if (this.incompleteTimer) clearTimeout(this.incompleteTimer)
      this.incompleteTimer = setTimeout(
        this.flushIncomplete,
        this.keyParseState.mode === 'IN_PASTE'
          ? this.PASTE_TIMEOUT
          : this.NORMAL_TIMEOUT,
      )
    }
  }

  private flushIncomplete = (): void => {
    this.incompleteTimer = null
    if (!this.keyParseState.incomplete) return
    const len = (this.stdin as any).readableLength
    if (typeof len === 'number' && len > 0) {
      this.incompleteTimer = setTimeout(
        this.flushIncomplete,
        this.NORMAL_TIMEOUT,
      )
      return
    }
    this.processInput(null)
  }
}

function processKeysInBatch(
  emitter: EventEmitter,
  items: ParsedInput[],
): void {
  for (const item of items) {
    if (item.kind === 'response') continue
    if (item.kind === 'mouse') continue
    const event = new InputEvent(item)
    emitter.emit('input', event)
  }
}
