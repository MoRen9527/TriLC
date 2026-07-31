/**
 * InputContext -- React Context for the CC input pipeline.
 *
 * Provides the EventEmitter and setRawMode to useInput hooks,
 * replacing CC's StdinContext.
 */
import { createContext, useContext } from 'react'
import type { InputPipeline } from './InputPipeline.js'

export interface InputContextValue {
  /** Enable/disable raw mode. Mirrors CC StdinContext.setRawMode. */
  setRawMode: (enabled: boolean) => void
  /** The event emitter that dispatches InputEvent objects. */
  internal_eventEmitter: InputPipeline['emitter'] | null
}

export const InputContext = createContext<InputContextValue>({
  setRawMode: () => {},
  internal_eventEmitter: null,
})

export function useInputContext(): InputContextValue {
  return useContext(InputContext)
}
