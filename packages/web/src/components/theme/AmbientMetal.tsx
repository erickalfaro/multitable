/**
 * Single WebGL ambient layer — living metallic field behind the frosted shell.
 * One canvas only. Colors track the active project hue; motion is nearly
 * subconscious. Pauses when the tab is hidden or the user prefers reduced motion.
 */

import { useEffect, useMemo, useState } from 'react';
import { MeshGradient } from '@paper-design/shaders-react';
import { useAppStore } from '../../stores/appStore';
import { useIsDark } from '../../hooks/useIsDark';
import { meshPaletteForProject } from '../../lib/metalPalette';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => (typeof document !== 'undefined' ? document.visibilityState === 'visible' : true),
  );
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  return visible;
}

/**
 * Same project-id resolution as useAmbientAccent — selection → sidebar → focused.
 */
function useAmbientProjectId(): string | null {
  return useAppStore((s) => {
    const sel = s.selectedProcessId;
    const fromSession = sel ? s.sessions[sel]?.projectId : undefined;
    return fromSession ?? s.sidebarProjectId ?? s.focusedProjectId ?? null;
  });
}

export function AmbientMetal() {
  const dark = useIsDark();
  const projectId = useAmbientProjectId();
  const colorOverride = useAppStore((s) =>
    projectId ? s.projectNav.colors?.[projectId] ?? null : null,
  );
  const reducedMotion = usePrefersReducedMotion();
  const visible = useDocumentVisible();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // Recompute when manual hue override changes (override map is module-level).
  const colors = useMemo(() => {
    void colorOverride;
    return meshPaletteForProject(projectId, dark);
  }, [projectId, dark, colorOverride]);

  // Defer WebGL one frame so first paint can use CSS ambient fallback.
  useEffect(() => {
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, []);

  // Soft WebGL probe — if the context is lost forever, keep CSS blooms.
  useEffect(() => {
    if (!ready || failed) return;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) setFailed(true);
    } catch {
      setFailed(true);
    }
  }, [ready, failed]);

  const speed = reducedMotion || !visible ? 0 : 0.08;

  if (!ready || failed) return null;

  return (
    <div className="mt-ambient-metal" aria-hidden>
      <MeshGradient
        colors={colors}
        distortion={0.5}
        swirl={0.2}
        grainMixer={0.12}
        grainOverlay={0.06}
        speed={speed}
        maxPixelCount={900_000}
        minPixelRatio={1}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}
