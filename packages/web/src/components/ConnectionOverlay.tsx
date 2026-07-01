import React from 'react';
import { useAppStore } from '../stores/appStore';
import { WifiOff, RefreshCw } from 'lucide-react';
import { wsClient } from '../lib/ws';
import { Button } from './ui';

export function ConnectionOverlay() {
  const connectionState = useAppStore(s => s.connectionState);

  if (connectionState === 'connected') return null;

  if (connectionState === 'reconnecting') {
    return (
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: 36,
          zIndex: 1100,
          background: 'color-mix(in srgb, var(--status-warning) 15%, transparent)',
          borderBottom: '1px solid var(--status-warning)',
          color: 'var(--status-warning)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          fontSize: 13,
          fontWeight: 500,
          userSelect: 'none',
          WebkitUserSelect: 'none',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          animation: 'mt-slide-up var(--dur-med) var(--ease-out)',
        }}
      >
        <RefreshCw
          size={14}
          style={{ animation: 'connection-spin 1s linear infinite' }}
        />
        <span>Reconnecting...</span>
      </div>
    );
  }

  // disconnected
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1500,
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(8px) saturate(1.1)',
        WebkitBackdropFilter: 'blur(8px) saturate(1.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'mt-fade-in var(--dur-med) var(--ease-out)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
          padding: 32,
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-xl)',
          animation: 'mt-scale-in var(--dur-med) var(--ease-out)',
          minWidth: 320,
        }}
      >
        <WifiOff size={40} style={{ color: 'var(--text-muted)' }} />
        <span
          style={{
            fontSize: 17,
            color: 'var(--text-primary)',
            fontWeight: 600,
          }}
        >
          Cannot connect to daemon
        </span>
        <span style={{ fontSize: 13, color: 'var(--text-muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
          localhost:3117
        </span>
        <Button variant="primary" onClick={() => wsClient.reconnect()}>
          Retry
        </Button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Start it with: <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>mt start</code>
        </span>
      </div>
    </div>
  );
}
