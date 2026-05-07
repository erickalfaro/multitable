import React from 'react';
import type { Message } from '../../../lib/types';
import type { TurnMessage } from './turnGrouping';
import { getNodeColorVar, getNodeLabel } from '../../../lib/nodeColor';

// Layout constants — kept here so the rail's geometry is described in one
// place. Cards rendered inside TurnRow have their outer margins reset
// (AssistantMessage/ToolCallCard/ReasoningCard) so first-line baselines are
// predictable: dot center sits at DOT_TOP from the row top and the line
// passes through that point continuously across rows.
const GUTTER       = 18; // left padding the card content sits at
const RAIL_X       = 5;  // x of the dot/line center within the gutter
const DOT_SIZE     = 7;  // dot diameter
const DOT_TOP      = 9;  // y center of dot from row top — aligns with cards' first text line
const ROW_GAP      = 8;  // breathing room between rows (padding-bottom)
const TURN_GAP_END = 14; // gap below the entire turn before the next user prompt
const LOADER_PX    = 18; // loader avatar diameter — circular node housing the loader

interface DotProps {
  message: Message;
  pending: boolean;
  isError: boolean;
}

function Dot({ message, pending, isError }: DotProps) {
  const colorVar = getNodeColorVar(message);
  const color = `var(${colorVar})`;
  return (
    <span
      title={getNodeLabel(message)}
      aria-hidden
      style={{
        position: 'absolute',
        left: RAIL_X - DOT_SIZE / 2,
        top: DOT_TOP - DOT_SIZE / 2,
        width: DOT_SIZE,
        height: DOT_SIZE,
        borderRadius: '50%',
        background: color,
        opacity: pending ? 0.55 : 1,
        boxShadow: isError
          ? '0 0 0 1.5px var(--bg-primary), 0 0 0 2.5px var(--status-error)'
          : '0 0 0 1.5px var(--bg-primary)',
        animation: pending ? 'mt-rail-pulse 1.6s ease-in-out infinite' : 'none',
        zIndex: 2,
      }}
    />
  );
}

function RailLine({
  fromTop,
  toBottom,
}: {
  fromTop: number;
  toBottom: number | string;
}) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        left: RAIL_X - 0.5,
        top: fromTop,
        bottom: toBottom,
        width: 1,
        background: 'var(--border-strong)',
        zIndex: 1,
      }}
    />
  );
}

interface TurnRowProps {
  messages: TurnMessage[];
  resultsByUseId: Map<string, { output: string; isError: boolean }>;
  /** When true, the LAST row's rail line extends past its dot to the bottom
      of the row — used so the rail visually flows into a TrailingLoader
      rendered as a sibling below. */
  extendLineDown?: boolean;
  /** One ReactNode per `messages` entry, in matching order. */
  children: React.ReactNode;
}

export function TurnRow({ messages, resultsByUseId, extendLineDown, children }: TurnRowProps) {
  const childArr = React.Children.toArray(children);
  const showLine = messages.length > 1 || (messages.length >= 1 && extendLineDown);

  return (
    <div style={{ marginBottom: TURN_GAP_END }}>
      {messages.map((m, i) => {
        const isFirst = i === 0;
        const isTerminal = i === messages.length - 1 && !extendLineDown;
        let pending = false;
        let isError = false;
        if (m.kind === 'tool_use') {
          const r = resultsByUseId.get(m.toolUseId);
          pending = !r;
          isError = !!r?.isError;
        }
        return (
          <div
            key={m.id}
            style={{
              position: 'relative',
              paddingBottom: i === messages.length - 1 && !extendLineDown ? 0 : ROW_GAP,
            }}
          >
            {showLine && (
              <RailLine
                fromTop={isFirst ? DOT_TOP : 0}
                toBottom={isTerminal ? `calc(100% - ${DOT_TOP}px)` : 0}
              />
            )}
            <Dot message={m} pending={pending} isError={isError} />
            <div style={{ paddingLeft: GUTTER, minWidth: 0 }}>{childArr[i] ?? null}</div>
          </div>
        );
      })}
    </div>
  );
}

interface TrailingLoaderProps {
  /** The avatar node to render at the rail's terminal position. */
  children: React.ReactNode;
  /** When true, draw a top-half line above the avatar so the rail visually
      flows from the previous TurnRow (which should set extendLineDown=true). */
  connected: boolean;
}

/**
 * Always-mounted terminal-node container at the bottom of the chat. Keeping
 * the avatar in a stable position here (rather than passing it through each
 * turn block as a tail) prevents React from unmounting / remounting the
 * dot-matrix loader on every block transition, which would reset its
 * animation state.
 */
export function TrailingLoader({ children, connected }: TrailingLoaderProps) {
  return (
    <div
      style={{
        position: 'relative',
        minHeight: LOADER_PX,
        // Pull up to close the gap left by the previous TurnRow's
        // marginBottom — the rail line should appear continuous.
        marginTop: connected ? -TURN_GAP_END : 0,
        marginBottom: TURN_GAP_END,
      }}
    >
      {connected && (
        <RailLine fromTop={0} toBottom={`calc(100% - ${DOT_TOP}px)`} />
      )}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: RAIL_X - LOADER_PX / 2,
          top: DOT_TOP - LOADER_PX / 2,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: LOADER_PX,
          height: LOADER_PX,
          zIndex: 2,
        }}
      >
        {children}
      </span>
      <div style={{ paddingLeft: GUTTER, height: LOADER_PX }} />
    </div>
  );
}
