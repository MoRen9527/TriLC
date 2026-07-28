// ── Theme system (CC-compatible token names, Ink rendering) ──
// CC uses a curried color() function backed by getTheme() + ThemeProvider.
// trilc adapts the same token vocabulary but renders via Ink's Text color prop.
import React, { createContext, useContext } from 'react';

// ── Theme token vocabulary (aligned with CC's Theme type) ──
export interface Theme {
  // Text
  text: string;
  secondaryText: string;
  dimText: string;
  // Accent
  warning: string;       // user messages, yellow
  success: string;       // done states, green
  error: string;         // error states, red
  info: string;          // model name, headers, cyan
  // Borders / chrome
  border: string;
  // Backgrounds
  bgSubtle: string;
  // Tool use
  toolUse: string;       // ● running
  toolUseDone: string;   // ● done (green)
  toolUseError: string;  // ● error (red)
}

// ── Dark theme (only theme for now) ──
export const darkTheme: Theme = {
  text: 'white',
  secondaryText: 'gray',
  dimText: 'gray',
  warning: 'yellow',
  success: 'green',
  error: 'red',
  info: 'cyan',
  border: 'gray',
  bgSubtle: '',
  toolUse: 'yellow',
  toolUseDone: 'green',
  toolUseError: 'red',
};

// ── Theme context ──
const ThemeContext = createContext<Theme>(darkTheme);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return React.createElement(ThemeContext.Provider, { value: darkTheme }, children);
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
