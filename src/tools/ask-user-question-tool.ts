// ── AskUserQuestionTool (CC-equivalent)
// Tool that allows AI to ask users multiple-choice questions.
// P3: interactive mode — when an interactive client (TUI) is mid-request,
// the handler parks on the interaction bridge until the user answers via
// keyboard. Non-interactive callers keep the default-option fallback.
// Uses agent-core tool registration (ToolDefinition + ToolHandler).

import type { ToolDefinition } from 'trimodel';
import { register as registerTool } from '@tricompany/agent-core';
import { isInteractiveActive, requestInteraction } from '../server/interactions.js';

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface AskUserQuestionInput {
  questions: Question[];
  answers?: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
}

export interface AskUserQuestionOutput {
  questions: Question[];
  answers: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
}

/**
 * Create the AskUserQuestionTool definition for agent-core.
 */
function createAskUserQuestionToolDef(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'ask_user_question',
      description: 'Prompt the user with a multiple-choice question. Display 2-4 options and get the user selection.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The complete question to ask the user. Should end with a question mark.',
                },
                header: {
                  type: 'string',
                  description: 'Very short label displayed as a chip/tag (max 20 chars). Examples: "Auth method", "Library", "Approach".',
                },
                options: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: 'object',
                    properties: {
                      label: {
                        type: 'string',
                        description: 'The display text for this option (1-5 words).',
                      },
                      description: {
                        type: 'string',
                        description: 'Explanation of what this option means.',
                      },
                      preview: {
                        type: 'string',
                        description: 'Optional preview content.',
                      },
                    },
                    required: ['label', 'description'],
                  },
                },
                multiSelect: {
                  type: 'boolean',
                  description: 'Allow selecting multiple options.',
                },
              },
              required: ['question', 'header', 'options'],
            },
          },
          answers: {
            type: 'object',
            description: 'Pre-existing answers (for internal use).',
          },
          annotations: {
            type: 'object',
            description: 'Per-question annotations from the user.',
          },
        },
        required: ['questions'],
      },
    },
  };
}

/** Fallback: first option per question (non-interactive / timeout path). */
function defaultAnswers(questions: Question[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    if (question.options && question.options.length > 0) {
      answers[question.question] = question.options[0]!.label;
    } else {
      answers[question.question] = 'No options available';
    }
  }
  return answers;
}

/** Response shape posted back by the TUI. */
interface QuestionInteractionResponse {
  answers?: Record<string, string>;
  cancelled?: boolean;
}

/**
 * Execute the question.
 * P3: interactive clients (TUI with interactive:true in flight) get a real
 * keyboard-driven prompt via the interaction bridge; everyone else gets the
 * default-option fallback so headless callers never hang.
 */
async function executeAskUserQuestionHandler(
  args: Record<string, unknown>,
): Promise<string> {
  const input = args as unknown as AskUserQuestionInput;
  const { questions } = input;

  if (!questions || questions.length === 0) {
    return JSON.stringify({ error: 'No questions provided' });
  }

  if (isInteractiveActive()) {
    const response = (await requestInteraction(
      'question',
      { questions },
      300_000, // 5min timeout → cancelled fallback
      { cancelled: true },
    )) as QuestionInteractionResponse;

    if (response && !response.cancelled && response.answers) {
      return JSON.stringify({ questions, answers: response.answers });
    }

    return JSON.stringify({
      questions,
      answers: defaultAnswers(questions),
      note: 'User cancelled or timed out — default option selected.',
    });
  }

  // Non-interactive fallback (headless clients, no TUI attached)
  return JSON.stringify({
    questions,
    answers: defaultAnswers(questions),
    note: 'No interactive client attached — default option selected.',
  });
}

/**
 * Register AskUserQuestionTool with agent-core.
 */
export function registerAskUserQuestionTool(): void {
  registerTool(createAskUserQuestionToolDef(), executeAskUserQuestionHandler);
}

/**
 * Format questions for display in TUI (static, non-interactive contexts).
 * The live prompt is rendered by InteractionPrompt in the TUI.
 */
export function formatQuestionsForDisplay(questions: Question[]): string {
  const lines: string[] = [];

  for (const question of questions) {
    lines.push(`\n【${question.header}】`);
    lines.push(`${question.question}`);
    lines.push('');
    for (let i = 0; i < question.options.length; i++) {
      const opt = question.options[i]!;
      const num = i + 1;
      lines.push(`  ${num}. ${opt.label} — ${opt.description}`);
      if (opt.preview) {
        // Truncate preview for display
        const truncated = opt.preview.length > 100
          ? opt.preview.slice(0, 100) + '...'
          : opt.preview;
        lines.push(`     Preview: ${truncated}`);
      }
    }
  }

  return lines.join('\n');
}
