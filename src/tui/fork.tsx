// @ts-nocheck
// Barrel: re-export the CC ink fork engine submodules (NOT the ink.ts barrel,
// which pulls in design-system CC deps we don't have). The fork lives at
// src/tui/ink/ with the engine at src/tui/ink/ink/.
export { default as Box } from './ink/ink/components/Box.js';
export { default as Text } from './ink/ink/components/Text.js';
export { default as render } from './ink/ink/root.js';
export type { DOMElement } from './ink/ink/dom.js';
