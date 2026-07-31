/**
 * CSI (Control Sequence Introducer) Types
 *
 * Enums and types for CSI command parameters.
 *
 * This is an A级 copy from CC vendor/claude-code-full/src/ink/termio/csi.ts.
 * Only the parts needed for the input pipeline (parse-keypress) are relevant.
 * CSI output helpers (cursorMove, eraseScreen, etc.) are retained for potential
 * future use but are not currently called by the input pipeline.
 */

import { ESC, ESC_TYPE, SEP } from './ansi.js'

export const CSI_PREFIX = ESC + String.fromCharCode(ESC_TYPE.CSI)

/**
 * CSI parameter byte ranges
 */
export const CSI_RANGE = {
  PARAM_START: 0x30,
  PARAM_END: 0x3f,
  INTERMEDIATE_START: 0x20,
  INTERMEDIATE_END: 0x2f,
  FINAL_START: 0x40,
  FINAL_END: 0x7e,
} as const

/** Check if a byte is a CSI parameter byte */
export function isCSIParam(byte: number): boolean {
  return byte >= CSI_RANGE.PARAM_START && byte <= CSI_RANGE.PARAM_END
}

/** Check if a byte is a CSI intermediate byte */
export function isCSIIntermediate(byte: number): boolean {
  return (
    byte >= CSI_RANGE.INTERMEDIATE_START && byte <= CSI_RANGE.INTERMEDIATE_END
  )
}

/** Check if a byte is a CSI final byte (@ through ~) */
export function isCSIFinal(byte: number): boolean {
  return byte >= CSI_RANGE.FINAL_START && byte <= CSI_RANGE.FINAL_END
}

/**
 * Generate a CSI sequence: ESC [ p1;p2;...;pN final
 * Single arg: treated as raw body
 * Multiple args: last is final byte, rest are params joined by ;
 */
export function csi(...args: (string | number)[]): string {
  if (args.length === 0) return CSI_PREFIX
  if (args.length === 1) return `${CSI_PREFIX}${args[0]}`
  const params = args.slice(0, -1)
  const final = args[args.length - 1]
  return `${CSI_PREFIX}${params.join(SEP)}${final}`
}

/**
 * CSI final bytes - the command identifier
 */
export const CSI = {
  // Cursor movement
  CUU: 0x41, // A - Cursor Up
  CUD: 0x42, // B - Cursor Down
  CUF: 0x43, // C - Cursor Forward
  CUB: 0x44, // D - Cursor Back
  CNL: 0x45, // E - Cursor Next Line
  CPL: 0x46, // F - Cursor Previous Line
  CHA: 0x47, // G - Cursor Horizontal Absolute
  CUP: 0x48, // H - Cursor Position
  CHT: 0x49, // I - Cursor Horizontal Tab
  VPA: 0x64, // d - Vertical Position Absolute
  HVP: 0x66, // f - Horizontal Vertical Position

  // Erase
  ED: 0x4a, // J - Erase in Display
  EL: 0x4b, // K - Erase in Line
  ECH: 0x58, // X - Erase Character

  // Insert/Delete
  IL: 0x4c, // L - Insert Lines
  DL: 0x4d, // M - Delete Lines
  ICH: 0x40, // @ - Insert Characters
  DCH: 0x50, // P - Delete Characters

  // Scroll
  SU: 0x53, // S - Scroll Up
  SD: 0x54, // T - Scroll Down

  // Modes
  SM: 0x68, // h - Set Mode
  RM: 0x6c, // l - Reset Mode

  // SGR
  SGR: 0x6d, // m - Select Graphic Rendition

  // Other
  DSR: 0x6e, // n - Device Status Report
  DECSCUSR: 0x71, // q - Set Cursor Style (with space intermediate)
  DECSTBM: 0x72, // r - Set Top and Bottom Margins
  SCOSC: 0x73, // s - Save Cursor Position
  SCORC: 0x75, // u - Restore Cursor Position
  CBT: 0x5a, // Z - Cursor Backward Tabulation
} as const

/**
 * Erase in Display regions (ED command parameter)
 */
export const ERASE_DISPLAY = ['toEnd', 'toStart', 'all', 'scrollback'] as const

/**
 * Erase in Line regions (EL command parameter)
 */
export const ERASE_LINE_REGION = ['toEnd', 'toStart', 'all'] as const

// Bracketed paste markers (input from terminal, not output)
// These are sent by the terminal to delimit pasted content when
// bracketed paste mode is enabled (via DEC mode 2004)

/** Sent by terminal before pasted content (CSI 200 ~) */
export const PASTE_START = csi('200~')

/** Sent by terminal after pasted content (CSI 201 ~) */
export const PASTE_END = csi('201~')

// Focus event markers (input from terminal, not output)

/** Sent by terminal when it gains focus (CSI I) */
export const FOCUS_IN = csi('I')

/** Sent by terminal when it loses focus (CSI O) */
export const FOCUS_OUT = csi('O')
