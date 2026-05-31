/**
 * Legacy entry point for the bottom-right slide-out panel. The body of this
 * surface now lives under `components/command-console/` — the panel is no
 * longer a passive history list; it's a tabbed Command Console that also
 * aggregates every pending permission/elicitation across all sessions and
 * lets the user respond inline.
 *
 * This file is kept as a 1-line re-export so `App.tsx` and `StatusBar.tsx`
 * continue to import `NotificationCenter` without churn.
 */
export { CommandConsole as NotificationCenter } from '../command-console/CommandConsole';
