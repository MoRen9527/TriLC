/**
 * Minimal stdin shim for npm ink.
 *
 * npm ink's App wraps our React tree and tries to manage stdin
 * (setRawMode + readable listener). We provide this shim so ink's
 * App can do its setup/teardown safely without touching real stdin.
 *
 * The REAL stdin is managed by InputPipeline.
 */
import { PassThrough } from 'node:stream'

export function createStdinShim(): NodeJS.ReadStream {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shim = new PassThrough() as any

  // Fake TTY so ink's isRawModeSupported() returns true
  shim.isTTY = true

  // Fake setRawMode -- no-op, real raw mode is managed by InputPipeline.
  // Node's ReadStream.setRawMode returns `this`, so we return shim.
  shim.setRawMode = function (_mode: boolean) { return shim }

  return shim as NodeJS.ReadStream
}
