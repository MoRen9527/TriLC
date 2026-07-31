/**
 * useTerminalInput -- CC-compatible useInput hook replacement
 *
 * Subscribes to InputPipeline's EventEmitter via React Context.
 * Signature matches CC's useInput: (input, key, event) => void.
 *
 * Adapted from CC vendor/claude-code-full/src/ink/hooks/use-input.ts.
 * Replaces: useEventCallback (usehooks-ts) with useCallback + ref,
 *           useStdin (CC StdinContext) with InputContext.
 *
 * Key difference from npm ink useInput:
 * - Receives pre-parsed InputEvent instead of raw string chunks
 * - key includes `fn`, `super`, `option` fields (CC extended Key type)
 * - input is pre-parsed by CC's input-event.ts parseKey
 */

import { useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { useInputContext } from '../termio/InputContext.js'
import type { InputEvent, Key } from '../termio/events/input-event.js'

type Handler = (input: string, key: Key, event: InputEvent) => void

type Options = {
  isActive?: boolean
}

/**
 * CC-compatible useInput hook.
 *
 * Usage:
 *   useInput((input, key, event) => {
 *     if (key.leftArrow) { ... }
 *     if (input === 'q') { ... }
 *   }, { isActive: true });
 */
export function useInput(inputHandler: Handler, options: Options = {}): void {
  const { setRawMode, internal_eventEmitter } = useInputContext()

  // useLayoutEffect so raw mode is enabled synchronously during commit phase
  useLayoutEffect(() => {
    if (options.isActive === false) return
    setRawMode(true)
    return () => {
      setRawMode(false)
    }
  }, [options.isActive, setRawMode])

  // useEventCallback replacement: stable function ref, always calls latest handler
  const handlerRef = useRef(inputHandler)
  const isActiveRef = useRef(options.isActive)
  useLayoutEffect(() => {
    handlerRef.current = inputHandler
    isActiveRef.current = options.isActive
  })

  const handleData = useCallback((event: InputEvent) => {
    if (isActiveRef.current === false) return
    const { input, key } = event
    handlerRef.current(input, key, event)
  }, [])

  useEffect(() => {
    internal_eventEmitter?.on('input', handleData)
    return () => {
      internal_eventEmitter?.removeListener('input', handleData)
    }
  }, [internal_eventEmitter, handleData])
}
