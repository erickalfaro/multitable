import { useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { useIsDark } from './useIsDark';
import { getProjectColor, type ProjectColor } from '../lib/projectColor';

/**
 * Reactive getProjectColor — re-renders the caller when the project's manual
 * hue override changes (the module-level map in projectColor.ts is synced by
 * the store before the state update, so this memo always reads fresh values).
 */
export function useProjectColor(projectId: string): ProjectColor {
  const dark = useIsDark();
  const overrideName = useAppStore((s) => s.projectNav.colors?.[projectId] ?? null);
  return useMemo(() => {
    // overrideName participates via the module-level override map inside
    // getProjectColor; referencing it keeps the memo (and the lint) honest.
    void overrideName;
    return getProjectColor(projectId, dark);
  }, [projectId, dark, overrideName]);
}
