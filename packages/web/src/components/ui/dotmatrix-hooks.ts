"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DotMatrixPhase } from "./dotmatrix-core";

// Loader animations always run, regardless of OS-level reduced-motion
// preference. The dot-matrix loaders are the primary "agent is working"
// indicator in MultiTable's UI; without animation users get no feedback
// during multi-second turns. We intentionally override a11y here because
// the loaders are small, low-contrast, and don't trigger vestibular
// disorders the way large parallax / spinning elements do.
//
// If a future a11y review wants to honor the preference, swap this back to
// `window.matchMedia("(prefers-reduced-motion: reduce)").matches` and also
// re-add the CSS `@media (prefers-reduced-motion: reduce)` block in
// `dotmatrix-loader.css`.
export function usePrefersReducedMotion(): boolean {
  return false;
}

export interface UseCyclePhaseOptions {
  active: boolean;
  cycleMsBase: number;
  speed?: number;
}

// Quantize the continuous 0..1 phase so React commits ~24 updates per cycle
// instead of one per animation frame. Each loader renders 25 dot spans with
// fresh style objects per phase change — at 60fps per loader (rail previews,
// sidebar rows, chat) that was the sidebar's dominant render cost. 24 steps
// is visually indistinguishable for these small ripple loaders.
const CYCLE_PHASE_STEPS = 24;

export function useCyclePhase({ active, cycleMsBase, speed = 1 }: UseCyclePhaseOptions): number {
  const [phase, setPhase] = useState(0);
  const currentQuantRef = useRef(-1);

  useEffect(() => {
    if (!active) {
      currentQuantRef.current = -1;
      setPhase(0);
      return;
    }

    const safeSpeed = speed > 0 ? speed : 1;
    const raw = cycleMsBase / safeSpeed;
    const cycleMs = raw > 0 && Number.isFinite(raw) ? raw : 1000;
    const start = performance.now();

    const update = (now: number) => {
      const elapsed = ((now - start) % cycleMs + cycleMs) % cycleMs;
      const quant = Math.floor((elapsed / cycleMs) * CYCLE_PHASE_STEPS);
      if (quant !== currentQuantRef.current) {
        currentQuantRef.current = quant;
        setPhase(quant / CYCLE_PHASE_STEPS);
      }
    };

    update(performance.now());
    // Shared frame bus: all live loaders ride ONE rAF loop instead of one each.
    return subscribeFrame(update);
  }, [active, cycleMsBase, speed]);

  return phase;
}

interface UseSteppedCycleOptions {
  active: boolean;
  cycleMsBase: number;
  steps: number;
  speed?: number;
  idleStep?: number;
}

type FrameListener = (now: number) => void;

const listeners = new Set<FrameListener>();
let rafId: number | null = null;

function emit(now: number) {
  listeners.forEach((listener) => {
    listener(now);
  });
}

function tick(now: number) {
  emit(now);
  if (listeners.size > 0) {
    rafId = window.requestAnimationFrame(tick);
  } else {
    rafId = null;
  }
}

function subscribeFrame(listener: FrameListener) {
  listeners.add(listener);
  if (rafId === null) {
    rafId = window.requestAnimationFrame(tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}

export function useSteppedCycle({
  active,
  cycleMsBase,
  steps,
  speed = 1,
  idleStep = 0
}: UseSteppedCycleOptions): number {
  const safeSteps = Math.max(1, Math.floor(steps));
  const safeSpeed = speed > 0 ? speed : 1;
  const rawCycleMs = cycleMsBase / safeSpeed;
  const rawStepMs = rawCycleMs / safeSteps;
  const stepMs = rawStepMs > 0 && Number.isFinite(rawStepMs) ? rawStepMs : 1;
  const cycleMs = stepMs * safeSteps;

  const [step, setStep] = useState(() => (active ? 0 : idleStep));
  const startMsRef = useRef<number>(0);
  const activeRef = useRef(false);
  const currentStepRef = useRef(idleStep);

  useEffect(() => {
    if (!active) {
      activeRef.current = false;
      currentStepRef.current = idleStep;
      setStep(idleStep);
      return;
    }

    const updateStep = (now: number) => {
      if (!activeRef.current) {
        startMsRef.current = now;
        activeRef.current = true;
      }

      const elapsed = Math.max(0, now - startMsRef.current);
      const nextStep = Math.floor((elapsed % cycleMs) / stepMs) % safeSteps;
      if (nextStep !== currentStepRef.current) {
        currentStepRef.current = nextStep;
        setStep(nextStep);
      }
    };

    updateStep(performance.now());
    return subscribeFrame(updateStep);
  }, [active, cycleMs, idleStep, safeSteps, stepMs]);

  return active ? step : idleStep;
}

interface UseDotMatrixPhasesOptions {
  animated?: boolean;
  hoverAnimated?: boolean;
  speed?: number;
}

interface DotMatrixPhasesResult {
  phase: DotMatrixPhase;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function useDotMatrixPhases({
  animated = false,
  hoverAnimated = false,
  speed = 1
}: UseDotMatrixPhasesOptions): DotMatrixPhasesResult {
  const safeSpeed = speed > 0 ? speed : 1;
  const autoRun = Boolean(animated && !hoverAnimated);
  const [hoverPhase, setHoverPhase] = useState<DotMatrixPhase>("idle");
  const timeouts = useRef<number[]>([]);
  const hoverGen = useRef(0);

  const clearTimers = useCallback(() => {
    for (let i = 0; i < timeouts.current.length; i += 1) {
      window.clearTimeout(timeouts.current[i]!);
    }
    timeouts.current = [];
  }, []);

  useEffect(() => {
    hoverGen.current += 1;
    clearTimers();
    return clearTimers;
  }, [autoRun, hoverAnimated, clearTimers]);

  const onMouseEnter = useCallback(() => {
    if (!hoverAnimated || autoRun) {
      return;
    }
    clearTimers();
    const gen = ++hoverGen.current;
    setHoverPhase("collapse");
    const collapseMs = Math.max(1, Math.round(300 / safeSpeed));
    const id = window.setTimeout(() => {
      if (hoverGen.current !== gen) {
        return;
      }
      setHoverPhase("hoverRipple");
    }, collapseMs);
    timeouts.current.push(id);
  }, [hoverAnimated, autoRun, safeSpeed, clearTimers]);

  const onMouseLeave = useCallback(() => {
    if (!hoverAnimated || autoRun) {
      return;
    }
    hoverGen.current += 1;
    clearTimers();
    setHoverPhase("idle");
  }, [hoverAnimated, autoRun, clearTimers]);

  const phase: DotMatrixPhase = autoRun ? "loadingRipple" : hoverAnimated ? hoverPhase : "idle";

  return useMemo(
    () => ({
      phase,
      onMouseEnter,
      onMouseLeave
    }),
    [phase, onMouseEnter, onMouseLeave]
  );
}
