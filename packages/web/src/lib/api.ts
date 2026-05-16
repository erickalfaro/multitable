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
    update: (id: string, data: Partial<Project>) => put<Project>(`/api/projects/${id}`, data),
    delete: (id: string) => del(`/api/projects/${id}`),
    setActive: (id: string) => put<Project>(`/api/projects/${id}/active`),
    startAll: (id: string) => post<void>(`/api/projects/${id}/start-all`),
    stopAll: (id: string) => post<void>(`/api/projects/${id}/stop-all`),
    files: (id: string, path?: string) => get<any[]>(`/api/projects/${id}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`),
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
        agentProvider?: 'claude' | 'codex' | 'hermes';
        model?: string;
      },
    ) => post<Session>(`/api/projects/${projectId}/sessions`, data),
    update: (id: string, data: Partial<Session>) => put<Session>(`/api/sessions/${id}`, data),
    delete: (id: string) => del(`/api/sessions/${id}`),
    reset: (id: string) => post<{ ok: boolean; session: Session }>(`/api/sessions/${id}/reset`),
    setMode: (id: string, mode: 'default' | 'plan' | 'accept-edits' | 'auto' | 'chat' | 'read-only') =>
      post<{ ok: boolean; mode: string }>(`/api/sessions/${id}/mode`, { mode }),
    stop: (id: string) => post<{ ok: boolean }>(`/api/sessions/${id}/stop`),
    renameAi: (id: string) => post<{ session: Session; name: string }>(`/api/sessions/${id}/rename-ai`),
    diff: (id: string) => get<{ diff: string }>(`/api/sessions/${id}/diff`),
    cost: (id: string) => get<{
      tokensIn: number;
      tokensOut: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      costUsd: number;
      model: string;
      messageCount: number;
    }>(`/api/sessions/${id}/cost`),
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
    models: (provider: 'claude' | 'codex' | 'hermes') =>
      get<{
        provider: string;
        models: Array<{
          id: string;
          displayName: string;
          description?: string;
          isDefault?: boolean;
        }>;
      }>(`/api/providers/${provider}/models`),
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
