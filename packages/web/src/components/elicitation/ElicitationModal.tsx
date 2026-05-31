import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { ElicitationPrompt } from '../../lib/types';
import { wsClient } from '../../lib/ws';
import { Modal, Button } from '../ui';
import {
  Field,
  coerce,
  defaultForField,
  type FieldSchema,
  type FormValue,
} from '../command-console/shared/elicitationFields';

/**
 * Full-screen blocking modal for URL-mode MCP elicitations only.
 *
 * Background: the Command Console now lists *every* pending elicitation
 * inline (`components/command-console/shared/ElicitationFormCard.tsx`,
 * `ElicitationUrlCard.tsx`). Form-mode prompts resolve there — they don't
 * need to interrupt whatever the user is doing.
 *
 * URL-mode prompts still pop a modal: browser-auth flows are security-
 * sensitive and benefit from a hard focus break. The URL row also still
 * appears in the Console so the user can act on it from the global inbox
 * if they dismissed the modal.
 *
 * (Form-mode rendering is kept in this file behind a feature flag — see
 * `ALLOW_FORM_MODAL` — in case we ever want to re-enable the blocking
 * variant; it's dead code today.)
 */

const ALLOW_FORM_MODAL = false;

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
      content[name] = coerce(name, field, values[name]) as string | number | boolean | string[];
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
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            wordBreak: 'break-all',
            marginBottom: 8,
          }}
        >
          {prompt.url}
        </div>
      )}
    </Modal>
  );
}

export function ElicitationModalHost() {
  const pending = useAppStore((s) => s.pendingElicitations);
  const removeElicitation = useAppStore((s) => s.removeElicitation);

  // Pick the highest-priority modal candidate: a URL-mode prompt anywhere in
  // the pending list. Form-mode prompts are deliberately not auto-popped —
  // they live inline in the Command Console (`ElicitationFormCard`).
  const current = useMemo(() => {
    const url = pending.find((p) => p.mode === 'url');
    if (url) return url;
    if (ALLOW_FORM_MODAL) return pending[0] ?? null;
    return null;
  }, [pending]);

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
  // Reachable only when ALLOW_FORM_MODAL is flipped on; today this branch is
  // dead code preserved as documentation.
  return <ElicitationForm prompt={current} onClose={onClose} />;
}
