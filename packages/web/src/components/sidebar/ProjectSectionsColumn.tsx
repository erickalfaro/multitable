import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { ProjectSections } from './ProjectSections';
import { useProjectColor } from '../../hooks/useProjectColor';
import { outlineColor, OUTLINE_WIDTH } from '../../lib/emphasis';

/**
 * Sections column — straight project-hue outline.
 *
 * Left edge opens when a rail session is docked (railSeamY) so the rail
 * session's open-right outline meets the panel.
 *
 * Right edge opens on the selected session row so that row's open-right
 * outline docks into the main pane — never a closed session card.
 * Projects alone never open either edge.
 */
export function ProjectSectionsColumn() {
  const projects = useAppStore((s) => s.projects);
  const sidebarProjectId = useAppStore((s) => s.sidebarProjectId);
  const selectedProcessId = useAppStore((s) => s.selectedProcessId);
  const activeProject = projects.find((p) => p.id === sidebarProjectId) ?? null;
  const hue = useProjectColor(sidebarProjectId ?? '__none__').dot;
  const hostRef = useRef<HTMLDivElement>(null);
  // Left gap — rail session dock.
  const [leftOpen, setLeftOpen] = useState(false);
  // Right gap — selected session row dock into main pane.
  const [rightOpen, setRightOpen] = useState(false);

  useEffect(() => {
    let prev: number | null | undefined;
    const apply = (y: number | null) => setLeftOpen(y != null);
    apply(useAppStore.getState().railSeamY);
    return useAppStore.subscribe((state) => {
      const y = state.railSeamY;
      if (y === prev) return;
      prev = y;
      apply(y);
    });
  }, []);

  // Measure the selected session row and open the panel's right edge there.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !selectedProcessId) {
      setRightOpen(false);
      host?.style.removeProperty('--right-open-top');
      host?.style.removeProperty('--right-open-bot');
      return;
    }

    let raf = 0;
    let cancelled = false;
    const measure = () => {
      raf = 0;
      if (cancelled || !host) return;
      const row = host.querySelector<HTMLElement>('.mt-sidebar-item.is-selected');
      if (!row) {
        setRightOpen(false);
        host.style.removeProperty('--right-open-top');
        host.style.removeProperty('--right-open-bot');
        return;
      }
      const pr = row.getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      // Row scrolled out of view → close the gap.
      if (pr.bottom < hr.top || pr.top > hr.bottom) {
        setRightOpen(false);
        return;
      }
      const openTop = Math.max(0, pr.top - hr.top);
      const openBot = Math.max(openTop, pr.bottom - hr.top);
      host.style.setProperty('--right-open-top', `${openTop}px`);
      host.style.setProperty('--right-open-bot', `${openBot}px`);
      setRightOpen(true);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };

    measure();
    const scrollEl = host.querySelector('.mt-scroll');
    scrollEl?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      scrollEl?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro.disconnect();
      setRightOpen(false);
    };
  }, [selectedProcessId, sidebarProjectId, activeProject?.id]);

  const line = activeProject ? outlineColor(hue) : 'transparent';
  const stroke = OUTLINE_WIDTH;

  return (
    <div
      ref={hostRef}
      className={'mt-sections-panel' + (activeProject ? ' is-framed' : '')}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
      }}
    >
      {activeProject && (
        <div
          aria-hidden
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2 }}
        >
          {/* top */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: stroke,
              background: line,
            }}
          />
          {/* bottom */}
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: stroke,
              background: line,
            }}
          />
          {/* right upper — ends at selected session top */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: stroke,
              height: rightOpen ? 'var(--right-open-top)' : '100%',
              background: line,
            }}
          />
          {/* right lower — starts at selected session bottom */}
          {rightOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'var(--right-open-bot)',
                right: 0,
                bottom: 0,
                width: stroke,
                background: line,
              }}
            />
          )}
          {/* left upper — ends at rail mark top */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: stroke,
              height: leftOpen ? 'var(--open-top)' : '100%',
              background: line,
            }}
          />
          {/* left lower — starts at rail mark bottom */}
          {leftOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'var(--open-bot)',
                left: 0,
                bottom: 0,
                width: stroke,
                background: line,
              }}
            />
          )}
        </div>
      )}

      <div
        className="mt-scroll"
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
          background: 'transparent',
        }}
      >
        {activeProject ? (
          <ProjectSections key={activeProject.id} project={activeProject} />
        ) : projects.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 14 }}>
            No project registered. Add a project to get started.
          </div>
        ) : (
          <div
            className="mt-display"
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
              textAlign: 'center',
              fontSize: 19,
            }}
          >
            select a <em>project</em>
          </div>
        )}
      </div>
    </div>
  );
}
