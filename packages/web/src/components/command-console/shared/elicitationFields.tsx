import React from 'react';
import { Input } from '../../ui';

/**
 * Shared JSON-Schema → form field renderer used by both the URL-mode
 * `ElicitationModal` and the inline `ElicitationFormCard` in the Command
 * Console. Kept in its own file so the modal and the inline card pull from a
 * single source — keeps validation behavior and visuals identical across
 * surfaces.
 */

export type FormValue = string | number | boolean | string[];

export interface FieldSchema {
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

export function defaultForField(_name: string, schema: FieldSchema): FormValue {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return String(schema.enum[0]);
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'array') return [];
  return '';
}

export function coerce(_name: string, schema: FieldSchema, raw: FormValue): FormValue {
  if (schema.type === 'number' || schema.type === 'integer') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (schema.type === 'boolean') return Boolean(raw);
  if (schema.type === 'array') {
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
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

export function Field({ name, schema, required, value, onChange }: FieldProps) {
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
