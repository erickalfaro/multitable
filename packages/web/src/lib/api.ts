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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) await failed(res);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) await failed(res);
  return res.json();
}

async function put<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'PUT',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) await failed(res);
  return res.json();
}

async function del(path: string): Promise<void> {
  const res = await fetch(BASE + path, { method: 'DELETE' });
  if (!res.ok) await failed(res);
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
        agentProvider?: 'claude' | 'codex';
        model?: string;
      },
    ) => post<Session>(`/api/projects/${projectId}/sessions`, data),
    update: (id: string, data: Partial<Session>) => put<Session>(`/api/sessions/${id}`, data),
    delete: (id: string) => del(`/api/sessions/${id}`),
    reset: (id: string) => post<{ ok: boolean; session: Session }>(`/api/sessions/${id}/reset`),
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
    models: (provider: 'claude' | 'codex') =>
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
