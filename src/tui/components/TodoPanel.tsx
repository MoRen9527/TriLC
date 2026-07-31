// ── TodoPanel component (P2-Batch1-#2) ──
// Displays todo tasks in a table format. Can be shown as a standalone panel
// or embedded in message output when TodoWrite is called.
import React from 'react';
import { Box, Text } from '../fork.js';

export interface TodoTask {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'low' | 'medium' | 'high';
}

interface TodoPanelProps {
  tasks: TodoTask[];
  title?: string;
}

export default function TodoPanel({ tasks, title = 'Tasks' }: TodoPanelProps) {
  if (tasks.length === 0) {
    return React.createElement(Box, { paddingX: 1, paddingY: 1 },
      React.createElement(Text, { dimColor: true, italic: true },
        `No ${title.toLowerCase()} yet.`
      ),
    );
  }

  // Sort: in_progress first, then pending, then completed
  const sortedTasks = [...tasks].sort((a, b) => {
    const statusOrder: Record<string, number> = { in_progress: 0, pending: 1, completed: 2 };
    const aOrder = statusOrder[a.status] ?? 1;
    const bOrder = statusOrder[b.status] ?? 1;
    if (aOrder !== bOrder) return aOrder - bOrder;
    // Within same status, sort by priority (high > medium > low)
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const aPriority = a.priority ? priorityOrder[a.priority] ?? 3 : 3;
    const bPriority = b.priority ? priorityOrder[b.priority] ?? 3 : 3;
    return aPriority - bPriority;
  });

  // Calculate column widths
  const maxIdWidth = Math.max(10, ...sortedTasks.map(t => t.id.length));
  const maxSubjectWidth = Math.max(20, ...sortedTasks.map(t => t.subject.length));
  const maxStatusWidth = 12; // "in_progress"
  const maxPriorityWidth = 8; // "MEDIUM"

  // Render header
  const headerRow = [
    'ID'.padEnd(maxIdWidth),
    'SUBJECT'.padEnd(maxSubjectWidth),
    'STATUS'.padEnd(maxStatusWidth),
    'PRIORITY',
  ].join(' │ ');

  const separatorRow = [
    '─'.repeat(maxIdWidth),
    '─'.repeat(maxSubjectWidth),
    '─'.repeat(maxStatusWidth),
    '─'.repeat(maxPriorityWidth),
  ].join('─┼─');

  // Render task rows
  const taskRows = sortedTasks.map((task, i) => {
    const statusSymbol = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '→' : '○';
    const statusColor = task.status === 'completed' ? 'green' : task.status === 'in_progress' ? 'yellow' : 'grey';
    const priorityText = (task.priority || '-').toUpperCase();

    return [
      task.id.padEnd(maxIdWidth),
      task.subject.padEnd(maxSubjectWidth),
      React.createElement(Text, { color: statusColor, bold: task.status === 'in_progress' },
        `${statusSymbol} ${task.status}`
      ),
      React.createElement(Text, {
        color: task.priority === 'high' ? 'red' : task.priority === 'medium' ? 'yellow' : 'grey',
        bold: task.priority === 'high'
      }, priorityText),
    ];
  });

  return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
    // Title
    React.createElement(Text, { bold: true, color: 'cyan' }, `${title} (${sortedTasks.length})`),
    React.createElement(Text, { dimColor: true }, ''),
    // Header
    React.createElement(Text, { bold: true, dimColor: true }, headerRow),
    React.createElement(Text, { dimColor: true }, separatorRow),
    // Task rows
    ...taskRows.map((cells, i) =>
      React.createElement(Box, { key: `todo-row-${i}`, flexDirection: 'row' },
        React.createElement(Text, { dimColor: true }, cells[0] as string),
        React.createElement(Text, null, ' │ '),
        React.createElement(Text, null, cells[1] as string),
        React.createElement(Text, null, ' │ '),
        ...(cells.slice(2) as Array<React.ReactElement>),
      ),
    ),
  );
}

// ── Inline todo list renderer ──
// Renders a compact todo list suitable for embedding in messages
export function renderTodoList(tasks: TodoTask[]): string {
  if (tasks.length === 0) return 'No tasks.';

  const sortedTasks = [...tasks].sort((a, b) => {
    const statusOrder = { in_progress: 0, pending: 1, completed: 2 };
    const aOrder = statusOrder[a.status] ?? 1;
    const bOrder = statusOrder[b.status] ?? 1;
    return aOrder - bOrder;
  });

  return sortedTasks.map(task => {
    const statusSymbol = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '→' : '○';
    const priority = task.priority ? ` [${task.priority.toUpperCase()}]` : '';
    return `${statusSymbol} ${task.id}${priority} — ${task.subject}`;
  }).join('\n');
}
