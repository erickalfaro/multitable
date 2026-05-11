import { v4 as uuidv4 } from 'uuid';
import type {
  AlertCategory,
  AlertSeverity,
  SessionAlert,
} from './types.js';

interface CreateAlertInput {
  sessionId: string;
  category: AlertCategory;
  severity: AlertSeverity;
  title: string;
  body?: string;
  needsAttention?: boolean;
  persistent?: boolean;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}

const DEFAULT_TTL_MS: Record<AlertSeverity, number | undefined> = {
  info: 3000,
  success: 3000,
  warning: 5000,
  error: 8000,
  attention: undefined,
};

const DEFAULT_NEEDS_ATTENTION: Record<AlertSeverity, boolean> = {
  info: false,
  success: false,
  warning: false,
  error: true,
  attention: true,
};

const DEFAULT_PERSISTENT: Record<AlertSeverity, boolean> = {
  info: false,
  success: true,
  warning: true,
  error: true,
  attention: true,
};

export function createAlert(input: CreateAlertInput): SessionAlert {
  return {
    alertId: uuidv4(),
    sessionId: input.sessionId,
    category: input.category,
    severity: input.severity,
    title: input.title,
    body: input.body,
    needsAttention: input.needsAttention ?? DEFAULT_NEEDS_ATTENTION[input.severity],
    persistent: input.persistent ?? DEFAULT_PERSISTENT[input.severity],
    ttlMs: input.ttlMs ?? DEFAULT_TTL_MS[input.severity],
    metadata: input.metadata,
    timestamp: Date.now(),
  };
}
