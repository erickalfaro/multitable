import React, { memo, useState } from 'react';
import {
  FileText,
  FilePenLine,
  Terminal as TerminalIcon,
  Search,
  Globe,
  Wrench,
  AlertTriangle,
  HelpCircle,
} from 'lucide-react';
import { CodeBlock } from './CodeBlock';

// "Ask the user a question" tools surface the same shape across providers:
// Claude's `AskUserQuestion` and Grok Build's `ask_user_question` both carry
// `{ questions: [{ question, header?, options: [{ label, description?, preview? }] }] }`.
// We render them as a legible read-only block (not raw JSON). Note: over the
// Grok agent-stdio surface this is non-interactive — Grok auto-completes the
// tool and ends the turn, so the user answers by replying in chat.
const ASK_QUESTION_TOOLS = new Set(['ask_user_question', 'AskUserQuestion']);

interface AskOption {
  label?: string;
  description?: string;
  preview?: string;
}
interface AskQuestion {
  question?: string;
  header?: string;
  options?: AskOption[];
}

function askQuestions(input: unknown): AskQuestion[] | null {
  if (!input || typeof input !== 'object') return null;
  const q = (input as { questions?: unknown }).questions;
  return Array.isArray(q) && q.length > 0 ? (q as AskQuestion[]) : null;
}

interface Props {
  toolName: string;
  input: unknown;
  output: string | null;
  isError: boolean;
  pending: boolean;
  /** Start expanded — used by the live in-progress card so streaming output is visible. */
  defaultOpen?: boolean;
}

function toolIcon(name: string, size = 13) {
  if (ASK_QUESTION_TOOLS.has(name)) return <HelpCircle size={size} />;
  switch (name) {
    case 'Read':
      return <FileText size={size} />;
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return <FilePenLine size={size} />;
    case 'Bash':
    case 'BashOutput':
      return <TerminalIcon size={size} />;
    case 'Grep':
    case 'Glob':
      return <Search size={size} />;
    case 'WebFetch':
    case 'WebSearch':
      return <Globe size={size} />;
    default:
      return <Wrench size={size} />;
  }
}

// Per-tool one-line summary. Keeps the collapsed card readable without
// having to dig into the JSON.
function toolSummary(toolName: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (ASK_QUESTION_TOOLS.has(toolName)) {
    const qs = askQuestions(input);
    return qs?.[0]?.question ?? 'Question for you';
  }
  switch (toolName) {
    case 'Read':
      return typeof input.file_path === 'string' ? input.file_path : '';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return typeof input.file_path === 'string' ? input.file_path : '';
    case 'Bash':
      return typeof input.command === 'string' ? input.command.slice(0, 120) : '';
    case 'Grep':
      return typeof input.pattern === 'string' ? input.pattern : '';
    case 'Glob':
      return typeof input.pattern === 'string' ? input.pattern : '';
    case 'WebFetch':
    case 'WebSearch':
      return typeof input.url === 'string' ? input.url : typeof input.query === 'string' ? input.query : '';
    case 'Task':
      return typeof input.description === 'string' ? input.description : '';
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} todo(s)` : '';
    default:
      return '';
  }
}

function languageForTool(toolName: string, input: any): string | undefined {
  if (toolName === 'Bash') return 'bash';
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'Read') {
    const path: string | undefined = typeof input?.file_path === 'string' ? input.file_path : undefined;
    if (!path) return undefined;
    const ext = path.split('.').pop()?.toLowerCase();
    return ext;
  }
  return undefined;
}

// Read-only rendering of an "ask the user a question" tool's questions/options.
function QuestionsBlock({ questions }: { questions: AskQuestion[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {questions.map((q, qi) => (
        <div key={qi}>
          {q.question && (
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-primary)',
                marginBottom: 6,
              }}
            >
              {q.question}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(q.options ?? []).map((o, oi) => (
              <div
                key={oi}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-snug)',
                  padding: '6px 9px',
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {o.label ?? `Option ${oi + 1}`}
                </div>
                {o.description && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {o.description}
                  </div>
                )}
                {o.preview && (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'var(--text-muted)',
                      marginTop: 3,
                      fontStyle: 'italic',
                    }}
                  >
                    {o.preview}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
        Reply in chat with your choice.
      </div>
    </div>
  );
}

export const ToolCallCard = memo(function ToolCallCard({ toolName, input, output, isError, pending, defaultOpen }: Props) {
  const questions = ASK_QUESTION_TOOLS.has(toolName) ? askQuestions(input) : null;
  const [open, setOpen] = useState(!!defaultOpen || !!questions);
  const summary = toolSummary(toolName, input);
  const lang = languageForTool(toolName, input);

  return (
    <div
      style={{
        margin: 0,
        // Recessed treatment: dashed faint outline + transparent background so
        // tool calls fall into the chat canvas. The user prompt is the only
        // chat surface that elevates; everything else lives flush with prose.
        border: `1px dashed ${isError ? 'var(--status-error)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-snug)',
        backgroundColor: 'transparent',
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          gap: 8,
          padding: '5px 10px',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-primary)',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            color: 'var(--text-muted)',
            fontSize: 11,
            fontFamily: 'inherit',
          }}
        >
          {open ? '[−]' : '[+]'}
        </span>
        <span style={{ color: isError ? 'var(--status-error)' : 'var(--text-muted)', display: 'inline-flex' }}>
          {isError ? <AlertTriangle size={12} /> : toolIcon(toolName, 12)}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-secondary)',
          }}
        >
          {toolName}
        </span>
        {summary && (
          <span
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              fontFamily: 'inherit',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              flex: 1,
            }}
          >
            {summary}
          </span>
        )}
        {pending && (
          <span
            style={{
              fontSize: 10,
              color: 'var(--accent-amber)',
              fontFamily: 'inherit',
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              marginLeft: 'auto',
            }}
          >
            running…
          </span>
        )}
      </button>

      {open && questions && (
        <div style={{ padding: '4px 10px 10px' }}>
          <QuestionsBlock questions={questions} />
        </div>
      )}

      {open && !questions && (
        <div style={{ padding: '4px 10px 10px' }}>
          <div
            style={{
              fontSize: 9.5,
              color: 'var(--text-muted)',
              marginTop: 6,
              marginBottom: 4,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
            }}
          >
            Input
          </div>
          <CodeBlock code={JSON.stringify(input, null, 2)} lang="json" />
          {output !== null && (
            <>
              <div
                style={{
                  fontSize: 9.5,
                  color: 'var(--text-muted)',
                  marginTop: 8,
                  marginBottom: 4,
                  textTransform: 'uppercase',
                  letterSpacing: '0.18em',
                }}
              >
                {isError ? 'Error' : 'Result'}
              </div>
              <CodeBlock code={output} lang={lang} />
            </>
          )}
        </div>
      )}
    </div>
  );
});
