import React from 'react';

type Input = Record<string, unknown>;

const codeBlockStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-primary)',
  margin: 0,
  padding: '8px 10px',
  backgroundColor: 'var(--bg-sidebar)',
  borderRadius: 'var(--radius-soft)',
  fontFamily: 'inherit',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflow: 'auto',
  maxHeight: 160,
};

const labelStyle: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.18em',
  color: 'var(--text-muted)',
  marginBottom: 4,
};

const rowStyle: React.CSSProperties = {
  marginBottom: 6,
};

const pathStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 12,
  color: 'var(--text-primary)',
  backgroundColor: 'var(--bg-sidebar)',
  padding: '3px 8px',
  borderRadius: 'var(--radius-snug)',
  display: 'inline-block',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const inlineStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-primary)',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function bool(v: unknown): boolean {
  return v === true;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={rowStyle}>
      <div style={labelStyle}>{label}</div>
      {children}
    </div>
  );
}

function Diff({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 4 }}>
      <div>
        <div style={{ ...labelStyle, color: 'var(--status-error)' }}>− Remove</div>
        <pre
          className="mt-scroll"
          style={{
            ...codeBlockStyle,
            backgroundColor: 'color-mix(in srgb, var(--status-error) 10%, transparent)',
            borderColor: 'color-mix(in srgb, var(--status-error) 30%, var(--border))',
          }}
        >
          {oldStr || '(empty)'}
        </pre>
      </div>
      <div>
        <div style={{ ...labelStyle, color: 'var(--accent-green, #22c55e)' }}>+ Add</div>
        <pre
          className="mt-scroll"
          style={{
            ...codeBlockStyle,
            backgroundColor: 'color-mix(in srgb, var(--accent-green, #22c55e) 10%, transparent)',
            borderColor: 'color-mix(in srgb, var(--accent-green, #22c55e) 30%, var(--border))',
          }}
        >
          {newStr || '(empty)'}
        </pre>
      </div>
    </div>
  );
}

function BashPreview({ input }: { input: Input }) {
  const command = str(input.command);
  const description = str(input.description);
  const timeout = num(input.timeout);
  return (
    <div>
      {description && (
        <Row label="Description">
          <div style={inlineStyle}>{description}</div>
        </Row>
      )}
      <Row label="Command">
        <pre className="mt-scroll" style={codeBlockStyle}>{command}</pre>
      </Row>
      {timeout !== undefined && (
        <Row label="Timeout">
          <div style={inlineStyle}>{timeout}ms</div>
        </Row>
      )}
    </div>
  );
}

function EditPreview({ input }: { input: Input }) {
  const file = str(input.file_path);
  const oldStr = str(input.old_string);
  const newStr = str(input.new_string);
  const replaceAll = bool(input.replace_all);
  return (
    <div>
      <Row label="File">
        <span style={pathStyle}>{file}</span>
        {replaceAll && (
          <span style={{ ...inlineStyle, marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
            replace all
          </span>
        )}
      </Row>
      <Diff oldStr={oldStr} newStr={newStr} />
    </div>
  );
}

function MultiEditPreview({ input }: { input: Input }) {
  const file = str(input.file_path);
  const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [];
  return (
    <div>
      <Row label="File">
        <span style={pathStyle}>{file}</span>
        <span style={{ ...inlineStyle, marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          {edits.length} edit{edits.length === 1 ? '' : 's'}
        </span>
      </Row>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {edits.map((e, i) => (
          <div key={i}>
            <div style={{ ...labelStyle, marginBottom: 4 }}>Edit {i + 1}{bool(e.replace_all) ? ' (replace all)' : ''}</div>
            <Diff oldStr={str(e.old_string)} newStr={str(e.new_string)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function WritePreview({ input }: { input: Input }) {
  const file = str(input.file_path);
  const content = str(input.content);
  const lineCount = content.split('\n').length;
  return (
    <div>
      <Row label="Write to">
        <span style={pathStyle}>{file}</span>
        <span style={{ ...inlineStyle, marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          {content.length.toLocaleString()} chars · {lineCount} lines
        </span>
      </Row>
      <Row label="Content">
        <pre className="mt-scroll" style={codeBlockStyle}>{content.length > 2000 ? content.slice(0, 2000) + '\n…' : content}</pre>
      </Row>
    </div>
  );
}

function ReadPreview({ input }: { input: Input }) {
  const file = str(input.file_path);
  const offset = num(input.offset);
  const limit = num(input.limit);
  return (
    <div>
      <Row label="Read">
        <span style={pathStyle}>{file}</span>
      </Row>
      {(offset !== undefined || limit !== undefined) && (
        <div style={{ ...inlineStyle, fontSize: 11, color: 'var(--text-muted)' }}>
          {offset !== undefined && <>offset {offset}</>}
          {offset !== undefined && limit !== undefined && ' · '}
          {limit !== undefined && <>limit {limit}</>}
        </div>
      )}
    </div>
  );
}

function GrepPreview({ input }: { input: Input }) {
  const pattern = str(input.pattern);
  const path = str(input.path);
  const glob = str(input.glob);
  const type = str(input.type);
  const outputMode = str(input.output_mode);
  return (
    <div>
      <Row label="Pattern">
        <pre className="mt-scroll" style={codeBlockStyle}>{pattern}</pre>
      </Row>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
        {path && <span><b>in</b> <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--text-primary)' }}>{path}</span></span>}
        {glob && <span><b>glob</b> <code>{glob}</code></span>}
        {type && <span><b>type</b> {type}</span>}
        {outputMode && <span><b>mode</b> {outputMode}</span>}
      </div>
    </div>
  );
}

function GlobPreview({ input }: { input: Input }) {
  const pattern = str(input.pattern);
  const path = str(input.path);
  return (
    <div>
      <Row label="Glob pattern">
        <pre className="mt-scroll" style={codeBlockStyle}>{pattern}</pre>
      </Row>
      {path && (
        <Row label="In">
          <span style={pathStyle}>{path}</span>
        </Row>
      )}
    </div>
  );
}

function LsPreview({ input }: { input: Input }) {
  const path = str(input.path);
  return (
    <Row label="List directory">
      <span style={pathStyle}>{path}</span>
    </Row>
  );
}

function WebFetchPreview({ input }: { input: Input }) {
  const url = str(input.url);
  const prompt = str(input.prompt);
  return (
    <div>
      <Row label="URL">
        <a href={url} target="_blank" rel="noreferrer" style={{ ...inlineStyle, fontSize: 12, wordBreak: 'break-all', color: 'var(--accent-blue)' }}>{url}</a>
      </Row>
      {prompt && (
        <Row label="Prompt">
          <pre className="mt-scroll" style={codeBlockStyle}>{prompt}</pre>
        </Row>
      )}
    </div>
  );
}

function WebSearchPreview({ input }: { input: Input }) {
  const query = str(input.query);
  return (
    <Row label="Search">
      <pre className="mt-scroll" style={codeBlockStyle}>{query}</pre>
    </Row>
  );
}

function TaskPreview({ input }: { input: Input }) {
  const description = str(input.description);
  const subagent = str(input.subagent_type);
  const prompt = str(input.prompt);
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        {subagent && (
          <span style={{ ...pathStyle, backgroundColor: 'color-mix(in srgb, var(--accent-blue) 15%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-blue) 40%, var(--border))' }}>
            {subagent}
          </span>
        )}
        {description && <span style={inlineStyle}>{description}</span>}
      </div>
      {prompt && (
        <Row label="Task prompt">
          <pre className="mt-scroll" style={codeBlockStyle}>{prompt.length > 1000 ? prompt.slice(0, 1000) + '\n…' : prompt}</pre>
        </Row>
      )}
    </div>
  );
}

function TodoWritePreview({ input }: { input: Input }) {
  const todos = Array.isArray(input.todos) ? (input.todos as Input[]) : [];
  return (
    <div>
      <div style={{ ...labelStyle, marginBottom: 6 }}>
        {todos.length} todo{todos.length === 1 ? '' : 's'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {todos.map((t, i) => {
          const status = str(t.status);
          const content = str(t.content) || str(t.activeForm) || str(t.subject);
          const mark =
            status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '○';
          const color =
            status === 'completed' ? 'var(--text-muted)' :
            status === 'in_progress' ? 'var(--accent-blue)' :
            'var(--text-primary)';
          return (
            <div key={i} style={{ fontSize: 12, color, display: 'flex', gap: 6 }}>
              <span style={{ width: 12, textAlign: 'center', flexShrink: 0 }}>{mark}</span>
              <span style={{ textDecoration: status === 'completed' ? 'line-through' : 'none' }}>{content}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExitPlanModePreview({ input }: { input: Input }) {
  const plan = str(input.plan);
  return (
    <Row label="Proposed plan">
      <pre className="mt-scroll" style={{ ...codeBlockStyle, maxHeight: 240 }}>{plan}</pre>
    </Row>
  );
}

function GenericPreview({ input }: { input: Input }) {
  // Readable fallback: render each top-level key/value as a row instead of
  // one big JSON blob. Handles primitives, strings, and stringifies nested
  // structures compactly.
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return <div style={{ ...inlineStyle, color: 'var(--text-muted)', fontSize: 11 }}>(no arguments)</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {entries.map(([key, value]) => {
        let rendered: React.ReactNode;
        if (typeof value === 'string') {
          rendered = value.length > 120 || value.includes('\n')
            ? <pre className="mt-scroll" style={codeBlockStyle}>{value}</pre>
            : <span style={inlineStyle}>{value}</span>;
        } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
          rendered = <span style={inlineStyle}>{String(value)}</span>;
        } else {
          rendered = <pre className="mt-scroll" style={codeBlockStyle}>{JSON.stringify(value, null, 2)}</pre>;
        }
        return <Row key={key} label={key}>{rendered}</Row>;
      })}
    </div>
  );
}

export function ToolInputPreview({ toolName, input }: { toolName: string; input: Input }) {
  // MCP tools have names like "mcp__server__tool" — strip the prefix for
  // display but still use the generic renderer since we don't know the schema.
  if (toolName.startsWith('mcp__')) {
    return <GenericPreview input={input} />;
  }

  switch (toolName) {
    case 'Bash':
      return <BashPreview input={input} />;
    case 'Edit':
      return <EditPreview input={input} />;
    case 'MultiEdit':
      return <MultiEditPreview input={input} />;
    case 'Write':
      return <WritePreview input={input} />;
    case 'Read':
    case 'NotebookRead':
      return <ReadPreview input={input} />;
    case 'Grep':
      return <GrepPreview input={input} />;
    case 'Glob':
      return <GlobPreview input={input} />;
    case 'LS':
      return <LsPreview input={input} />;
    case 'WebFetch':
      return <WebFetchPreview input={input} />;
    case 'WebSearch':
      return <WebSearchPreview input={input} />;
    case 'Task':
    case 'Agent':
      return <TaskPreview input={input} />;
    case 'TodoWrite':
      return <TodoWritePreview input={input} />;
    case 'ExitPlanMode':
      return <ExitPlanModePreview input={input} />;
    default:
      return <GenericPreview input={input} />;
  }
}
