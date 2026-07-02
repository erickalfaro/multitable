import React from 'react';
import {
  MessageSquare,
  Wrench,
  ShieldAlert,
  HelpCircle,
  Gauge,
  KeyRound,
  ListChecks,
  Archive,
  RefreshCw,
  DollarSign,
  Activity,
  type LucideIcon,
} from 'lucide-react';
import type { AlertCategory, AlertSeverity, SessionAlert } from './types';
import { emphasisFill } from './emphasis';

/**
 * Visual mappings for the SessionAlert system. The daemon emits both a
 * `category` (what kind of event) and a `severity` (urgency) on every alert;
 * this module owns the per-category icon + tint and the per-severity tint
 * color so every rendering surface (NotificationCenter, toasts, sidebar
 * badges) reads from one source of truth.
 *
 * Design intent: category drives the icon shape + foreground color so users
 * can tell a `rate-limit` apart from an `auth` failure at a glance, while
 * severity continues to drive the surface tint / chime so the established
 * red-error, green-success urgency vocabulary survives.
 */

export const CATEGORY_ICON: Record<AlertCategory, LucideIcon> = {
  turn: MessageSquare,
  tool: Wrench,
  permission: ShieldAlert,
  elicitation: HelpCircle,
  'rate-limit': Gauge,
  auth: KeyRound,
  task: ListChecks,
  compaction: Archive,
  sync: RefreshCw,
  budget: DollarSign,
  status: Activity,
};

export const CATEGORY_COLOR_VAR: Record<AlertCategory, string> = {
  turn: 'var(--cat-turn)',
  tool: 'var(--cat-tool)',
  permission: 'var(--cat-permission)',
  elicitation: 'var(--cat-elicitation)',
  'rate-limit': 'var(--cat-rate-limit)',
  auth: 'var(--cat-auth)',
  task: 'var(--cat-task)',
  compaction: 'var(--cat-compaction)',
  sync: 'var(--cat-sync)',
  budget: 'var(--cat-budget)',
  status: 'var(--cat-status)',
};

export const SEVERITY_TINT_VAR: Record<AlertSeverity, string> = {
  info: 'var(--text-secondary)',
  success: 'var(--status-running)',
  warning: 'var(--status-stopped)',
  error: 'var(--status-error)',
  attention: 'var(--accent-amber)',
};

/**
 * The tinted-glass emphasis block for a severity: a soft severity-tinted fill
 * plus an inset hairline ring. Replaces the old 3px severity left border on
 * cards, rows, and toasts.
 */
export function severityEmphasis(severity: AlertSeverity): React.CSSProperties {
  return emphasisFill(SEVERITY_TINT_VAR[severity], {
    fill: 8,
    ring: 30,
    on: 'var(--bg-elevated)',
    highlight: false,
  });
}

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  attention: 4,
  error: 3,
  warning: 2,
  success: 1,
  info: 0,
};

/** Render a category-specific lucide icon, tinted with its category color. */
export function categoryIcon(category: AlertCategory, size = 14): React.ReactNode {
  const Icon = CATEGORY_ICON[category];
  return <Icon size={size} color={CATEGORY_COLOR_VAR[category]} />;
}

/**
 * Pick the "dominant" alert for a session — highest severity wins, ties
 * broken by most recent. Used by sidebar badges to choose which category
 * color to tint with when multiple alerts are pending. Returns null when
 * the session has no alerts.
 */
export function dominantAlertForSession(
  alerts: readonly SessionAlert[],
  sessionId: string,
): SessionAlert | null {
  let best: SessionAlert | null = null;
  for (const a of alerts) {
    if (a.sessionId !== sessionId) continue;
    if (
      !best ||
      SEVERITY_RANK[a.severity] > SEVERITY_RANK[best.severity] ||
      (SEVERITY_RANK[a.severity] === SEVERITY_RANK[best.severity] && a.timestamp > best.timestamp)
    ) {
      best = a;
    }
  }
  return best;
}

/**
 * Pick the dominant alert across a set of sessions (used by ProjectRail to
 * roll a project's per-session alerts up to one project-level badge tint).
 */
export function dominantAlertForSessions(
  alerts: readonly SessionAlert[],
  sessionIds: ReadonlySet<string>,
): SessionAlert | null {
  let best: SessionAlert | null = null;
  for (const a of alerts) {
    if (!sessionIds.has(a.sessionId)) continue;
    if (
      !best ||
      SEVERITY_RANK[a.severity] > SEVERITY_RANK[best.severity] ||
      (SEVERITY_RANK[a.severity] === SEVERITY_RANK[best.severity] && a.timestamp > best.timestamp)
    ) {
      best = a;
    }
  }
  return best;
}
