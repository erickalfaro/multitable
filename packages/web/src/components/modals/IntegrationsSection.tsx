import React, { useEffect, useState } from 'react';
import { Send, Trash2, Plus, AlertTriangle, CheckCircle2, Lock, Smartphone } from 'lucide-react';
import { api } from '../../lib/api';
import type { TelegramIntegrationView } from '../../lib/types';
import { Button, Input, IconButton, Badge } from '../ui';
import toast from 'react-hot-toast';

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--text-secondary)',
  marginBottom: 6,
};

const fieldStyle: React.CSSProperties = {
  marginBottom: 14,
};

const helpStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--text-muted)',
  marginTop: 4,
  lineHeight: 1.45,
};

const hintBox: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  fontSize: 11.5,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '6px 8px',
  marginTop: 6,
  lineHeight: 1.45,
};

const checkboxRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12.5,
  color: 'var(--text-primary)',
  cursor: 'pointer',
  padding: '3px 0',
};

export function IntegrationsSection() {
  const [view, setView] = useState<TelegramIntegrationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Token & toggle drafts (require explicit Save). Chat IDs auto-save on
  // Add/Remove because the user almost always means "add this and use it".
  const [tokenDraft, setTokenDraft] = useState('');
  const [editingToken, setEditingToken] = useState(false);
  const [newChatId, setNewChatId] = useState('');
  const [sendNotifications, setSendNotifications] = useState(true);
  const [sendAlerts, setSendAlerts] = useState(true);
  const [dashboardUrlDraft, setDashboardUrlDraft] = useState('');

  useEffect(() => {
    api.integrations.telegram
      .get()
      .then((v) => {
        setView(v);
        setSendNotifications(v.sendNotifications);
        setSendAlerts(v.sendAlerts);
        setDashboardUrlDraft(v.dashboardUrl);
      })
      .catch(() => toast.error('Failed to load Telegram settings'))
      .finally(() => setLoading(false));
  }, []);

  const tokenLocked = view?.tokenSource === 'env';
  const chatIds = (view?.chatIds ?? []).map(String);

  const apply = async (
    body: Parameters<typeof api.integrations.telegram.update>[0],
    successMsg?: string,
  ): Promise<TelegramIntegrationView | null> => {
    setBusy(true);
    try {
      const updated = await api.integrations.telegram.update(body);
      setView(updated);
      setSendNotifications(updated.sendNotifications);
      setSendAlerts(updated.sendAlerts);
      setDashboardUrlDraft(updated.dashboardUrl);
      if (successMsg) toast.success(successMsg);
      return updated;
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save Telegram settings');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleAddChatId = async () => {
    const trimmed = newChatId.trim();
    if (!trimmed) return;
    if (!/^-?\d+$/.test(trimmed)) {
      toast.error('Chat ID must be a number (positive for users, negative for groups)');
      return;
    }
    if (chatIds.includes(trimmed)) {
      toast.error('Chat ID already in list');
      return;
    }
    const next = [...chatIds, trimmed].map(Number);
    const updated = await apply({ chatIds: next }, 'Chat ID added');
    if (updated) setNewChatId('');
  };

  const handleRemoveChatId = async (id: string) => {
    const next = chatIds.filter((x) => x !== id).map(Number);
    await apply({ chatIds: next }, 'Chat ID removed');
  };

  const handleSaveToken = async () => {
    const trimmed = tokenDraft.trim();
    if (!trimmed) {
      toast.error('Paste a token first');
      return;
    }
    const updated = await apply({ token: trimmed }, 'Token saved');
    if (updated) {
      setTokenDraft('');
      setEditingToken(false);
    }
  };

  const handleClearToken = async () => {
    if (tokenLocked) return;
    if (!confirm('Clear the saved Telegram bot token?')) return;
    const updated = await apply({ token: null }, 'Token cleared');
    if (updated) {
      setTokenDraft('');
      setEditingToken(false);
    }
  };

  const handleSaveToggles = async () => {
    await apply({ sendNotifications, sendAlerts }, 'Saved');
  };

  const handleSaveDashboardUrl = async () => {
    const trimmed = dashboardUrlDraft.trim();
    if (trimmed.length > 0 && !/^https?:\/\//i.test(trimmed)) {
      toast.error('URL must start with http:// or https://');
      return;
    }
    await apply({ dashboardUrl: trimmed }, trimmed ? 'Dashboard URL saved' : 'Dashboard URL cleared');
  };

  if (loading || !view) {
    return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>;
  }

  const togglesDirty =
    sendNotifications !== view.sendNotifications || sendAlerts !== view.sendAlerts;
  const dashboardUrlDirty = dashboardUrlDraft.trim() !== view.dashboardUrl;

  return (
    <div>
      {/* Status banner */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Send size={14} style={{ color: 'var(--accent-blue)' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            Telegram bot
          </span>
          {view.running ? (
            <Badge variant="running" size="sm">running</Badge>
          ) : view.hasToken && view.chatIds.length === 0 ? (
            <Badge variant="warning" size="sm">no chat IDs</Badge>
          ) : !view.hasToken ? (
            <Badge variant="muted" size="sm">no token</Badge>
          ) : (
            <Badge variant="muted" size="sm">stopped</Badge>
          )}
        </div>
        <div style={helpStyle}>
          Mirror permission prompts and notifications to a Telegram chat. Tap inline buttons to
          approve, deny, or answer questions from your phone. Create a bot with{' '}
          <a
            href="https://t.me/botfather"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent-blue)' }}
          >
            @BotFather
          </a>{' '}
          to get a token, then DM your bot <code>/chatid</code> to discover your chat ID.
        </div>
      </div>

      {/* Token */}
      <div style={fieldStyle}>
        <label style={labelStyle}>Bot token</label>
        {tokenLocked ? (
          <div style={hintBox}>
            <Lock size={12} style={{ marginTop: 2, color: 'var(--text-muted)' }} />
            <span style={{ color: 'var(--text-secondary)' }}>
              Token is set via the <code>MULTITABLE_TELEGRAM_BOT_TOKEN</code> environment variable.
              Unset it to manage the token from here.
            </span>
          </div>
        ) : view.hasToken && !editingToken ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', flex: 1 }}>
              <CheckCircle2 size={12} style={{ verticalAlign: 'middle', marginRight: 6, color: 'var(--status-running)' }} />
              Token is set <span style={{ color: 'var(--text-muted)' }}>(stored in <code>secrets.yml</code>)</span>
            </span>
            <Button size="sm" variant="secondary" onClick={() => setEditingToken(true)}>
              Replace
            </Button>
            <Button size="sm" variant="ghost" onClick={handleClearToken} disabled={busy}>
              Clear
            </Button>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Input
                type="password"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
                autoComplete="off"
                wrapperStyle={{ flex: 1, maxWidth: 460 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSaveToken();
                  }
                }}
              />
              <Button size="sm" variant="primary" onClick={handleSaveToken} disabled={busy || tokenDraft.trim().length === 0}>
                Save token
              </Button>
              {view.hasToken && (
                <Button size="sm" variant="ghost" onClick={() => { setEditingToken(false); setTokenDraft(''); }}>
                  Cancel
                </Button>
              )}
            </div>
            <div style={helpStyle}>
              Saved to <code>~/.config/multitable/secrets.yml</code> with mode <code>0600</code>.
              Press Enter or click Save token to commit.
            </div>
          </div>
        )}
      </div>

      {/* Chat IDs */}
      <div style={fieldStyle}>
        <label style={labelStyle}>Authorized chat IDs</label>
        {chatIds.length === 0 && (
          <div style={hintBox}>
            <AlertTriangle size={12} style={{ marginTop: 2, color: 'var(--status-stopped)' }} />
            <span style={{ color: 'var(--text-secondary)' }}>
              No chat IDs yet. Add at least one — only allowlisted chats can approve prompts.
            </span>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
          {chatIds.map((id) => (
            <div
              key={id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 8px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-sidebar)',
              }}
            >
              <span style={{ fontSize: 12.5, color: 'var(--text-primary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', flex: 1 }}>
                {id}
              </span>
              <IconButton size="sm" variant="danger" label="Remove" disabled={busy} onClick={() => handleRemoveChatId(id)}>
                <Trash2 size={12} />
              </IconButton>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Input
            value={newChatId}
            onChange={(e) => setNewChatId(e.target.value)}
            placeholder="e.g. 123456789"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddChatId();
              }
            }}
            wrapperStyle={{ maxWidth: 240 }}
          />
          <Button size="sm" variant="secondary" leftIcon={<Plus size={12} />} disabled={busy || newChatId.trim().length === 0} onClick={handleAddChatId}>
            Add
          </Button>
        </div>
        <div style={helpStyle}>
          Adds save instantly. DM your bot <code>/chatid</code> after configuring the token — the
          bot replies with the numeric chat ID to paste here.
        </div>
      </div>

      {/* Dashboard URL */}
      <div style={fieldStyle}>
        <label style={labelStyle}>Dashboard URL (for "Open in dashboard" links)</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <Input
            value={dashboardUrlDraft}
            onChange={(e) => setDashboardUrlDraft(e.target.value)}
            placeholder="http://epc.tail146615.ts.net:5173"
            wrapperStyle={{ flex: 1, maxWidth: 460 }}
            leftIcon={<Smartphone size={12} />}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSaveDashboardUrl();
              }
            }}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !dashboardUrlDirty}
            onClick={handleSaveDashboardUrl}
          >
            Save URL
          </Button>
        </div>
        <div style={helpStyle}>
          The URL your phone uses to reach this dashboard (e.g. via Tailscale). Telegram messages
          get an "Open in dashboard" button that deep-links to the specific permission card.
          Leave blank to disable the deep links.
        </div>
      </div>

      {/* Toggles */}
      <div style={fieldStyle}>
        <label style={labelStyle}>Forwarded events</label>
        <label style={checkboxRow}>
          <input
            type="checkbox"
            checked={sendNotifications}
            onChange={(e) => setSendNotifications(e.target.checked)}
          />
          Forward Claude notifications (e.g. agent waiting for input)
        </label>
        <label style={checkboxRow}>
          <input
            type="checkbox"
            checked={sendAlerts}
            onChange={(e) => setSendAlerts(e.target.checked)}
          />
          Forward agent alerts (errors, warnings, status changes)
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button size="sm" variant="primary" disabled={busy || !togglesDirty} onClick={handleSaveToggles}>
            Save toggles
          </Button>
        </div>
        <div style={helpStyle}>
          Permission prompts are always forwarded — that's the point of the integration.
        </div>
      </div>
    </div>
  );
}
