import type {
  Project,
  Session,
  Command,
  Terminal,
  GlobalConfig,
  Note,
  Message,
  TelegramIntegrationView,
  TelegramIntegrationUpdate,
  GitStatusSummary,
  GitLogEntry,
  GitBranchList,
  PermissionPrompt,
  ElicitationPrompt,
  OptionPrompt,
  UsageLimitSnapshot,
} from './types';
import { devLog } from './devLog';

const BASE = '';  // same origin

// Read the JSON body's `error` field on a non-OK response and bubble it up
// as the Error message — much better signal than just "502 Bad Gateway".
async function failed(res: Response): Promise<never> {
  let detail = '';
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') detail = body.error;
  } catch {}
  throw new Error(detail || `${res.status} ${res.statusText}`);
}

async function logged<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  init: RequestInit,
  parse: (res: Response) => Promise<T>,
): Promise<T> {
  const start = performance.now();
  const url = BASE + path;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const dur = performance.now() - start;
    devLog.add({
      category: 'api',
      level: 'error',
      label: `${method} ${path}`,
      detail: `network error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Math.round(dur),
    });
    throw err;
  }
  const dur = Math.round(performance.now() - start);
  if (!res.ok) {
    // Tee the body so we can both log it and bubble the parsed error up.
    let detail = '';
    try {
      const text = await res.clone().text();
      detail = text;
    } catch {
      // ignore
    }
    devLog.add({
      category: 'api',
      level: 'error',
      label: `${method} ${path} → ${res.status}`,
      detail,
      durationMs: dur,
    });
    await failed(res);
  }
  devLog.add({
    category: 'api',
    label: `${method} ${path} → ${res.status}`,
    durationMs: dur,
  });
  return parse(res);
}

async function get<T>(path: string): Promise<T> {
  return logged<T>('GET', path, {}, (r) => r.json());
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  return logged<T>(
    'POST',
    path,
    {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    },
    (r) => r.json(),
  );
}

async function put<T>(path: string, body?: unknown): Promise<T> {
  return logged<T>(
    'PUT',
    path,
    {
      method: 'PUT',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    },
    (r) => r.json(),
  );
}

async function del(path: string): Promise<void> {
  await logged<void>('DELETE', path, { method: 'DELETE' }, async () => {
    return undefined as void;
  });
}

export const api = {
  projects: {
    list: () => get<Project[]>('/api/projects'),
    get: (id: string) => get<Project>(`/api/projects/${id}`),
    create: (data: { path: string }) => post<Project>('/api/projects', data),
    browse: () => post<{ path: string | null }>('/api/projects/browse'),
    // Web-based host directory browser (replaces the host-side native picker for
    // remote/Tailscale/mobile clients). Lists subdirectories of an arbitrary
    // directory on the daemon host; omit `path` to default to the host home dir.
    browseDir: (path?: string) =>
      get<{
        path: string;
        parent: string | null;
        entries: Array<{ name: string; path: string; type: 'directory' }>;
        roots: Array<{ label: string; path: string }>;
      }>(`/api/projects/browse-dir${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    mkdir: (parent: string, name: string) =>
      post<{ path: string }>('/api/projects/browse-mkdir', { parent, name }),
    update: (id: string, data: Partial<Project>) => put<Project>(`/api/projects/${id}`, data),
    delete: (id: string) => del(`/api/projects/${id}`),
    setActive: (id: string) => put<Project>(`/api/projects/${id}/active`),
    startAll: (id: string) => post<void>(`/api/projects/${id}/start-all`),
    stopAll: (id: string) => post<void>(`/api/projects/${id}/stop-all`),
    files: (id: string, path?: string, all?: boolean) => {
      const qs = new URLSearchParams();
      if (path) qs.set('path', path);
      if (all) qs.set('all', '1');
      const suffix = qs.toString();
      return get<
        Array<{
          name: string;
          path: string;
          type: 'directory' | 'file';
          size: number;
          modifiedAt: number;
        }>
      >(`/api/projects/${id}/files${suffix ? `?${suffix}` : ''}`);
    },
    // Paginated, memory-bounded directory read for the File Viewer tree. Passing
    // `limit` switches the daemon to the envelope response (vs the legacy array
    // returned by `files()` above, still used by the @-mention index).
    filesPage: (
      id: string,
      opts: { path?: string; all?: boolean; limit: number; offset: number },
    ) => {
      const qs = new URLSearchParams();
      if (opts.path) qs.set('path', opts.path);
      if (opts.all) qs.set('all', '1');
      qs.set('limit', String(opts.limit));
      qs.set('offset', String(opts.offset));
      return get<{
        entries: Array<{
          name: string;
          path: string;
          type: 'directory' | 'file';
          size: number;
          modifiedAt: number;
        }>;
        total: number;
        offset: number;
        limit: number;
        hasMore: boolean;
        truncated: boolean;
      }>(`/api/projects/${id}/files?${qs.toString()}`);
    },
    readFile: (id: string, filePath: string) =>
      get<{ content: string; exists: boolean; size?: number; modifiedAt?: number }>(
        `/api/projects/${id}/file-content?path=${encodeURIComponent(filePath)}`,
      ),
    saveFile: (id: string, filePath: string, content: string) =>
      post<{ ok: true; path: string; size: number; modifiedAt: number }>(
        `/api/projects/${id}/file-content`,
        { path: filePath, content },
      ),
    // Upload a single binary file under `targetDir` (empty = project root). The
    // request body is the raw file; filename + target dir travel in headers to
    // dodge multipart parsing — matches the attachment endpoint shape. The
    // server rejects collisions with 409 so the caller can surface a per-file
    // toast and retry under a new name.
    uploadFile: async (
      id: string,
      targetDir: string,
      file: File,
    ): Promise<{ ok: true; path: string; size: number; modifiedAt: number }> => {
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}/file-upload`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name || 'upload'),
          'X-Target-Dir': encodeURIComponent(targetDir || ''),
        },
        body: file,
      });
      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          /* keep status fallback */
        }
        const err = new Error(msg) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as {
        ok: true;
        path: string;
        size: number;
        modifiedAt: number;
      };
    },
    openFile: (id: string, filePath: string) => post<void>(`/api/projects/${id}/open-file`, { path: filePath }),
    diff: (id: string) => get<{ diff: string }>(`/api/projects/${id}/diff`),
    slashCommands: (id: string) =>
      get<{ commands: Array<{ name: string; scope: 'project' | 'user'; description: string }> }>(
        `/api/projects/${id}/slash-commands`
      ),
  },
  sessions: {
    get: (id: string) => get<Session>(`/api/sessions/${id}`),
    list: (projectId: string) => get<Session[]>(`/api/projects/${projectId}/sessions`),
    create: (
      projectId: string,
      data: {
        name: string;
        command: string;
        agentProvider?: 'claude' | 'codex' | 'hermes' | 'grok' | 'cursor';
        model?: string;
        // Optional creation-time mode. Required UX for Grok (modeSwitchScope ===
        // 'creation'); recommended for any provider whose mode-switch scope is
        // non-'live' (Codex/Cursor/Hermes), so the user explicitly picks rather
        // than relying on the per-provider seed.
        mode?: string;
      },
    ) => post<Session>(`/api/projects/${projectId}/sessions`, data),
    update: (id: string, data: Partial<Session>) => put<Session>(`/api/sessions/${id}`, data),
    delete: (id: string) => del(`/api/sessions/${id}`),
    reset: (id: string) => post<{ ok: boolean; session: Session }>(`/api/sessions/${id}/reset`),
    // `mode` is a provider-native string — Claude `PermissionMode` or Codex
    // `SandboxMode`. The daemon validates against the adapter's declared
    // `capabilities.modes` and returns 400 on mismatch.
    setMode: (id: string, mode: string) =>
      post<{ ok: boolean; mode: string }>(`/api/sessions/${id}/mode`, { mode }),
    setThinkingEffort: (
      id: string,
      thinkingEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    ) =>
      post<{ ok: boolean; thinkingEffort: string }>(
        `/api/sessions/${id}/thinking-effort`,
        { thinkingEffort },
      ),
    stop: (id: string) => post<{ ok: boolean }>(`/api/sessions/${id}/stop`),
    renameAi: (id: string) =>
      post<{ session: Session; name: string; tags: string[] }>(`/api/sessions/${id}/rename-ai`),
    cost: (id: string) => get<{
      tokensIn: number;
      tokensOut: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      costUsd: number;
      model: string;
      messageCount: number;
    }>(`/api/sessions/${id}/cost`),
    usageLimits: (id: string) =>
      get<UsageLimitSnapshot | null>(`/api/sessions/${id}/usage-limits`),
    prompts: (id: string) => get<{
      prompts: Array<{ text: string; timestamp: number | null }>;
      source: 'jsonl' | 'jsonl-project' | 'memory';
    }>(`/api/sessions/${id}/prompts`),
    messages: (id: string) => get<{
      messages: Message[];
      endOffset: number;
    }>(`/api/sessions/${id}/messages`),
  },
  commands: {
    list: (projectId: string) => get<Command[]>(`/api/projects/${projectId}/commands`),
    create: (projectId: string, data: { name: string; command: string }) =>
      post<Command>(`/api/projects/${projectId}/commands`, data),
    update: (id: string, data: Partial<Command>) => put<Command>(`/api/commands/${id}`, data),
    delete: (id: string) => del(`/api/commands/${id}`),
  },
  terminals: {
    list: (projectId: string) => get<Terminal[]>(`/api/projects/${projectId}/terminals`),
    create: (projectId: string, data: { name?: string; shell?: string; workingDirectory?: string }) =>
      post<Terminal>(`/api/projects/${projectId}/terminals`, data),
    update: (id: string, data: Partial<Terminal>) => put<Terminal>(`/api/terminals/${id}`, data),
    delete: (id: string) => del(`/api/terminals/${id}`),
  },
  processes: {
    start: (id: string) => post<void>(`/api/processes/${id}/start`),
    stop: (id: string) => post<void>(`/api/processes/${id}/stop`),
    restart: (id: string) => post<void>(`/api/processes/${id}/restart`),
    clearScrollback: (id: string) => del(`/api/processes/${id}/scrollback`),
  },
  providers: {
    models: (provider: 'claude' | 'codex' | 'hermes' | 'grok' | 'cursor') =>
      get<{
        provider: string;
        models: Array<{
          id: string;
          displayName: string;
          description?: string;
          isDefault?: boolean;
          supportsEffort?: boolean;
          effortLevels?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
          defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
        }>;
        lastRefreshed: number | null;
        lastError: string | null;
      }>(`/api/providers/${provider}/models`),
    // Full snapshot across all providers. Used once at app boot to seed the
    // in-memory model catalog so model pickers render instantly.
    catalog: () =>
      get<
        Record<
          'claude' | 'codex' | 'hermes' | 'grok' | 'cursor',
          {
            models: Array<{
              id: string;
              displayName: string;
              description?: string;
              isDefault?: boolean;
              supportsEffort?: boolean;
              effortLevels?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
              defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
            }>;
            lastRefreshed: number | null;
            lastError: string | null;
          }
        >
      >('/api/providers/catalog'),
    // Adapter capability bag for a provider, fetched without needing a session.
    // Used by AddAgentModal so the creation-time mode picker can render the
    // adapter-declared modes and gate creation-only providers (e.g. Grok).
    capabilities: (provider: 'claude' | 'codex' | 'hermes' | 'grok' | 'cursor') =>
      get<{ provider: string; capabilities: import('./types').ProviderCapabilities }>(
        `/api/providers/${provider}/capabilities`,
      ),
    // Trigger live discovery. Server returns 202; the actual catalog lands
    // via the `providers:catalog-updated` WS event.
    refresh: (provider?: 'claude' | 'codex' | 'hermes' | 'grok' | 'cursor') =>
      post<{ ok: boolean; refreshing: string[] }>(
        '/api/providers/refresh',
        provider ? { provider } : {},
      ),
  },

  // In-flight popups the daemon is still holding, re-fetched on load /
  // reconnect / bfcache-resume so a browser refresh doesn't strand a session
  // that's blocked waiting on a permission / question / elicitation prompt.
  prompts: {
    pending: () =>
      get<{
        permissions: PermissionPrompt[];
        elicitations: ElicitationPrompt[];
        options: OptionPrompt[];
      }>('/api/pending-prompts'),
  },
  config: {
    get: () => get<GlobalConfig>('/api/config'),
    update: (data: Partial<GlobalConfig>) => put<GlobalConfig>('/api/config', data),
  },
  integrations: {
    telegram: {
      get: () => get<TelegramIntegrationView>('/api/integrations/telegram'),
      update: (data: TelegramIntegrationUpdate) =>
        put<TelegramIntegrationView>('/api/integrations/telegram', data),
    },
  },
  notes: {
    listForSession: (sessionId: string, projectId: string) =>
      get<{ notes: Note[] }>(`/api/notes?sessionId=${encodeURIComponent(sessionId)}&projectId=${encodeURIComponent(projectId)}`),
    listForProject: (projectId: string) =>
      get<{ notes: Note[] }>(`/api/notes?projectId=${encodeURIComponent(projectId)}`),
    create: (data: { projectId: string; sessionId?: string | null; scope: 'session' | 'project'; title?: string; content?: string }) =>
      post<Note>('/api/notes', data),
    update: (id: string, data: Partial<{ title: string; content: string; scope: 'session' | 'project'; sessionId: string | null }>) =>
      put<Note>(`/api/notes/${id}`, data),
    delete: (id: string) => del(`/api/notes/${id}`),
    refine: (id: string) => post<{ refined: string; original: string }>(`/api/notes/${id}/refine`, {}),
  },
  git: {
    status: (projectId: string) =>
      get<GitStatusSummary>(`/api/projects/${projectId}/git/status`),
    diff: (projectId: string, opts?: { staged?: boolean }) =>
      get<{ diff: string }>(
        `/api/projects/${projectId}/git/diff${opts?.staged ? '?staged=1' : ''}`
      ),
    fileDiff: (projectId: string, filePath: string, opts?: { staged?: boolean }) =>
      get<{ diff: string }>(
        `/api/projects/${projectId}/git/diff/file?path=${encodeURIComponent(filePath)}${
          opts?.staged ? '&staged=1' : ''
        }`
      ),
    log: (projectId: string, limit?: number) =>
      get<{ commits: GitLogEntry[] }>(
        `/api/projects/${projectId}/git/log${limit ? `?limit=${limit}` : ''}`
      ),
    branches: (projectId: string) =>
      get<GitBranchList>(`/api/projects/${projectId}/git/branches`),
    stage: (projectId: string, files: string[]) =>
      post<{ ok: true }>(`/api/projects/${projectId}/git/stage`, { files }),
    unstage: (projectId: string, files: string[]) =>
      post<{ ok: true }>(`/api/projects/${projectId}/git/unstage`, { files }),
    commit: (projectId: string, message: string) =>
      post<{ sha: string; summary: { changes: number; insertions: number; deletions: number } }>(
        `/api/projects/${projectId}/git/commit`,
        { message }
      ),
    discard: (projectId: string, files: string[]) =>
      post<{ ok: true }>(`/api/projects/${projectId}/git/discard`, { files }),
    createBranch: (projectId: string, name: string, checkout = true) =>
      post<{ ok: true; branch: string }>(`/api/projects/${projectId}/git/branches`, {
        name,
        checkout,
      }),
    checkout: (projectId: string, branch: string) =>
      post<{ ok: true; branch: string }>(`/api/projects/${projectId}/git/checkout`, { branch }),
    stash: (projectId: string, message?: string) =>
      post<{ ok: true }>(`/api/projects/${projectId}/git/stash`, { message }),
    stashPop: (projectId: string) =>
      post<{ ok: true }>(`/api/projects/${projectId}/git/stash/pop`),
    fetch: (projectId: string, remote?: string) =>
      post<{ ok: true; summary: string }>(`/api/projects/${projectId}/git/fetch`, { remote }),
    pull: (projectId: string, opts?: { remote?: string; branch?: string }) =>
      post<{ ok: true; summary: string }>(`/api/projects/${projectId}/git/pull`, opts ?? {}),
    push: (projectId: string, opts?: { setUpstream?: boolean; remote?: string; branch?: string }) =>
      post<{ ok: true; summary: string }>(`/api/projects/${projectId}/git/push`, opts ?? {}),
    deleteBranch: (projectId: string, name: string, force = false) =>
      del(`/api/projects/${projectId}/git/branches/${encodeURIComponent(name)}${force ? '?force=1' : ''}`),
    aiCommitMessage: (projectId: string) =>
      post<{ message: string }>(`/api/projects/${projectId}/git/ai-commit-message`, {}),
  },
  search: (q: string) =>
    get<Array<{ sessionId: string; name: string; snippet: string }>>(
      `/api/search?q=${encodeURIComponent(q)}`
    ),
  transcripts: {
    list: (params?: { q?: string; cwd?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.q) qs.set('q', params.q);
      if (params?.cwd) qs.set('cwd', params.cwd);
      if (params?.limit) qs.set('limit', String(params.limit));
      const tail = qs.toString() ? `?${qs.toString()}` : '';
      return get<{
        projects: { cwd: string; projectName: string; sessionCount: number }[];
        sessions: {
          sessionId: string;
          cwd: string;
          projectName: string;
          gitBranch: string | null;
          firstPrompt: string | null;
          mtime: number;
          pinnedSessionId: string | null;
        }[];
      }>(`/api/transcripts${tail}`);
    },
    resume: (sessionId: string) =>
      post<{ ok: boolean; sessionId: string; projectId: string; pid: number | null }>(
        `/api/transcripts/${sessionId}/resume`
      ),
    listCodex: (params?: { cwd?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.cwd) qs.set('cwd', params.cwd);
      if (params?.limit) qs.set('limit', String(params.limit));
      const tail = qs.toString() ? `?${qs.toString()}` : '';
      return get<{
        projects: { cwd: string; projectName: string; sessionCount: number }[];
        sessions: {
          sessionId: string;
          cwd: string;
          projectName: string;
          gitBranch: string | null;
          firstPrompt: string | null;
          mtime: number;
          pinnedSessionId: string | null;
        }[];
      }>(`/api/transcripts/codex${tail}`);
    },
    resumeCodex: (threadId: string) =>
      post<{ ok: boolean; sessionId: string; projectId: string; pid: number | null }>(
        `/api/transcripts/codex/${threadId}/resume`
      ),
  },
};

// Route a stop request to the correct backend endpoint based on process type.
// Sessions (agent SDK turns) use /api/sessions/:id/stop, which calls
// agentManager.abortTurn — they do NOT have a PTY to kill. Commands and
// terminals are PTY processes and use /api/processes/:id/stop. Hitting the
// PTY route for a session id returns 404 ("Process not found"), which is the
// bug behind the Stop-button errors.
export function stopProcessByType(p: { id: string; type: 'session' | 'command' | 'terminal' }) {
  if (p.type === 'session') return api.sessions.stop(p.id);
  return api.processes.stop(p.id);
}
