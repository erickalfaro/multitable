import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { wsClient } from '../../../lib/ws';
import type { ElicitationPrompt } from '../../../lib/types';
import { Button } from '../../ui';
import { severityEmphasis, categoryIcon, CATEGORY_COLOR_VAR } from '../../../lib/alertVisuals';
import {
  Field,
  coerce,
  defaultForField,
  type FieldSchema,
  type FormValue,
} from './elicitationFields';

/**
 * Inline form-mode elicitation card for the Command Console. Same schema
 * rendering and submit/decline/cancel paths as the modal version
 * (`ElicitationModal`'s `ElicitationForm`) — minus the modal chrome.
 *
 * Field state is local to this component instance. The parent's keying
 * strategy (using `prompt.id` as the React key) ensures that toggling the
 * Console open/closed remounts the card with fresh defaults, which matches
 * the modal's lifecycle and avoids stale values from a previous prompt.
 */
export function ElicitationFormCard({
  prompt,
  compact = false,
}: {
  prompt: ElicitationPrompt;
  compact?: boolean;
}) {
  const removeElicitation = useAppStore((s) => s.removeElicitation);
  const [expanded, setExpanded] = useState(false);

  const rawSchema = (prompt.requestedSchema ?? {}) as {
    properties?: Record<string, FieldSchema>;
    required?: string[];
  };
  const fields = rawSchema.properties ?? {};
  const required = new Set(rawSchema.required ?? []);
  const fieldEntries = Object.entries(fields);
  const hasFields = fieldEntries.length > 0;

  const [values, setValues] = useState<Record<string, FormValue>>(() => {
    const init: Record<string, FormValue> = {};
    for (const [name, field] of Object.entries(fields)) {
      init[name] = defaultForField(name, field);
    }
    return init;
  });

  const onClose = () => removeElicitation(prompt.id);

  const submit = () => {
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

  const decline = () => {
    wsClient.respondElicitation(prompt.id, 'decline');
    onClose();
  };

  const cancel = () => {
    wsClient.respondElicitation(prompt.id, 'cancel');
    onClose();
  };

  return (
    <div
      style={{
        position: 'relative',
        ...severityEmphasis('attention'),
        padding: compact ? '10px 10px 8px 13px' : '12px 12px 10px 15px',
        marginBottom: compact ? 6 : 8,
      }}
    >
      <button
        onClick={() => setExpanded((x) => !x)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          width: '100%',
          textAlign: 'left',
        }}
      >
        {expanded ? (
          <ChevronDown size={12} color="var(--text-muted)" />
        ) : (
          <ChevronRight size={12} color="var(--text-muted)" />
        )}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 9.5,
            color: CATEGORY_COLOR_VAR.elicitation,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            fontWeight: 500,
          }}
        >
          {categoryIcon('elicitation', 11)}
          <span>elicitation · {prompt.serverName}</span>
        </div>
      </button>
      <div
        style={{
          fontSize: 12.5,
          color: 'var(--text-primary)',
          fontWeight: 500,
          marginTop: 6,
          lineHeight: 1.3,
        }}
      >
        {prompt.title || prompt.message}
      </div>
      {prompt.title && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          {prompt.message}
        </div>
      )}
      {expanded && (
        <>
          {prompt.description && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--text-muted)',
                marginTop: 8,
                marginBottom: 8,
              }}
            >
              {prompt.description}
            </div>
          )}
          <div style={{ marginTop: 10 }}>
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
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                No structured fields requested — Decline or Submit (empty) to respond.
              </div>
            )}
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <Button size="sm" variant="primary" onClick={submit} disabled={!hasFields && !expanded}>
          {expanded ? 'Submit' : 'Accept'}
        </Button>
        <Button size="sm" variant="secondary" onClick={decline}>
          Decline
        </Button>
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="danger" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
