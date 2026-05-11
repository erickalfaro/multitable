import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { ElicitationPrompt } from '../../lib/types';
import { wsClient } from '../../lib/ws';
import { Modal, Button, Input } from '../ui';

type FormValue = string | number | boolean | string[];

interface FieldSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  enum?: Array<string | number | boolean>;
  default?: FormValue;
  items?: { type?: string; enum?: Array<string | number | boolean> };
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

function defaultForField(name: string, schema: FieldSchema): FormValue {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return String(schema.enum[0]);
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'array') return [];
  return '';
}

function coerce(name: string, schema: FieldSchema, raw: FormValue): FormValue {
  if (schema.type === 'number' || schema.type === 'integer') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (schema.type === 'boolean') return Boolean(raw);
  if (schema.type === 'array') {
    return Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === 'string')
      : [];
  }
  return String(raw ?? '');
}

interface FieldProps {
  name: string;
  schema: FieldSchema;
  required: boolean;
  value: FormValue;
  onChange: (v: FormValue) => void;
}

function Field({ name, schema, required, value, onChange }: FieldProps) {
  const labelText = schema.title || name;

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    marginBottom: 4,
  };
  const descStyle: React.CSSProperties = {
    fontSize: 11.5,
    color: 'var(--text-muted)',
    marginTop: 4,
  };

  if (schema.enum && schema.enum.length > 0) {
    return (
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>
          {labelText}
          {required && <span style={{ color: 'var(--status-error)' }}> *</span>}
        </label>
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '100%',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '6px 10px',
            color: 'var(--text-primary)',
            fontSize: 13,
          }}
        >
          {schema.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
        {schema.description && <div style={descStyle}>{schema.description}</div>}
      </div>
    );
  }

  if (schema.type === 'boolean') {
    return (
      <div style={{ marginBottom: 12 }}>
        <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          {labelText}
          {required && <span style={{ color: 'var(--status-error)' }}> *</span>}
        </label>
        {schema.description && <div style={descStyle}>{schema.description}</div>}
      </div>
    );
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    return (
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>
          {labelText}
          {required && <span style={{ color: 'var(--status-error)' }}> *</span>}
        </label>
        <Input
          type="number"
          min={schema.minimum}
          max={schema.maximum}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {schema.description && <div style={descStyle}>{schema.description}</div>}
      </div>
    );
  }

  // Default: string input. Multi-line if maxLength suggests freeform text.
  const isLong = (schema.maxLength ?? 0) > 200 || schema.format === 'textarea';
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>
        {labelText}
        {required && <span style={{ color: 'var(--status-error)' }}> *</span>}
      </label>
      {isLong ? (
        <textarea
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          style={{
            width: '100%',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '6px 10px',
            color: 'var(--text-primary)',
            fontSize: 13,
            fontFamily: 'inherit',
            resize: 'vertical',
          }}
        />
      ) : (
        <Input
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
        />
      )}
      {schema.description && <div style={descStyle}>{schema.description}</div>}
    </div>
  );
}

interface FormProps {
  prompt: ElicitationPrompt;
  onClose: () => void;
}

function ElicitationForm({ prompt, onClose }: FormProps) {
  const schema = (prompt.requestedSchema ?? {}) as {
    properties?: Record<string, FieldSchema>;
    required?: string[];
  };
  const fields = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const [values, setValues] = useState<Record<string, FormValue>>(() => {
    const init: Record<string, FormValue> = {};
    for (const [name, field] of Object.entries(fields)) {
      init[name] = defaultForField(name, field);
    }
    return init;
  });

  const submit = (): void => {
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const [name, field] of Object.entries(fields)) {
      content[name] = coerce(name, field, values[name]) as
        | string
        | number
        | boolean
        | string[];
    }
    wsClient.respondElicitation(prompt.id, 'accept', content);
    onClose();
  };

  const decline = (): void => {
    wsClient.respondElicitation(prompt.id, 'decline');
    onClose();
  };

  const cancel = (): void => {
    wsClient.respondElicitation(prompt.id, 'cancel');
    onClose();
  };

  const fieldEntries = Object.entries(fields);
  const hasFields = fieldEntries.length > 0;

  return (
    <Modal
      open
      onClose={cancel}
      title={prompt.title || `${prompt.serverName} requests input`}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={decline}>
            Decline
          </Button>
          <Button variant="primary" onClick={submit} disabled={!hasFields}>
            Submit
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
        {prompt.message}
      </div>
      {prompt.description && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          {prompt.description}
        </div>
      )}
      {hasFields ? (
        fieldEntries.map(([name, field]) => (
          <Field
            key={name}
            name={name}
            schema={field}
            required={required.has(name)}
            value={values[name]}
            onChange={(v) => setValues((s) => ({ ...s, [name]: v }))}
          />
        ))
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          No structured fields requested — Decline or Submit (empty) to respond.
        </div>
      )}
    </Modal>
  );
}

interface UrlProps {
  prompt: ElicitationPrompt;
  onClose: () => void;
}

function ElicitationUrl({ prompt, onClose }: UrlProps) {
  const accept = (): void => {
    wsClient.respondElicitation(prompt.id, 'accept');
    onClose();
  };
  const cancel = (): void => {
    wsClient.respondElicitation(prompt.id, 'cancel');
    onClose();
  };
  return (
    <Modal
      open
      onClose={cancel}
      title={prompt.title || `${prompt.serverName} needs browser auth`}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (prompt.url) {
                try {
                  window.open(prompt.url, '_blank', 'noopener');
                } catch {
                  /* ignore popup-blocker errors */
                }
              }
              accept();
            }}
            leftIcon={<ExternalLink size={12} />}
            disabled={!prompt.url}
          >
            Open and continue
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
        {prompt.message}
      </div>
      {prompt.url && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', wordBreak: 'break-all', marginBottom: 8 }}>
          {prompt.url}
        </div>
      )}
    </Modal>
  );
}

export function ElicitationModalHost() {
  const pending = useAppStore((s) => s.pendingElicitations);
  const removeElicitation = useAppStore((s) => s.removeElicitation);
  const current = useMemo(() => pending[0] ?? null, [pending]);

  // Keep the WS authoritative — remove the local entry only after it's also
  // resolved server-side. Server's elicitation:resolved broadcast already
  // clears the store; this onClose is just for the optimistic close path.
  const onClose = (): void => {
    if (current) removeElicitation(current.id);
  };

  // Hide on ESC explicitly so the modal doesn't trap focus when there's
  // nothing to render.
  useEffect(() => {
    if (!current) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && current) {
        wsClient.respondElicitation(current.id, 'cancel');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current]);

  if (!current) return null;
  if (current.mode === 'url') return <ElicitationUrl prompt={current} onClose={onClose} />;
  return <ElicitationForm prompt={current} onClose={onClose} />;
}
