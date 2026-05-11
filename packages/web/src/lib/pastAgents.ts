import toast from 'react-hot-toast';
import { api } from './api';
import { useAppStore } from '../stores/appStore';

export const PAST_AGENTS_REFRESH_EVENT = 'mt:past-sessions-refresh';

async function loadProjectChildren(projectId: string) {
  const [s, c, t] = await Promise.all([
    api.sessions.list(projectId),
    api.commands.list(projectId),
    api.terminals.list(projectId),
  ]);
  const store = useAppStore.getState();
  store.mergeSessions(s);
  store.mergeCommands(c);
  store.mergeTerminals(t);
}

export async function selectPinnedSession(pinnedSessionId: string): Promise<boolean> {
  const store = useAppStore.getState();
  const cached = store.sessions[pinnedSessionId];
  if (cached) {
    store.expandProject(cached.projectId);
    store.setSelectedProcess(pinnedSessionId);
    return true;
  }
  try {
    for (const p of store.projects) {
      const sessions = await api.sessions.list(p.id);
      const match = sessions.find((s) => s.id === pinnedSessionId);
      if (match) {
        store.mergeSessions(sessions);
        store.expandProject(p.id);
        store.setSelectedProcess(pinnedSessionId);
        return true;
      }
    }
    toast.error('Could not locate that agent');
  } catch {
    toast.error('Could not switch to agent');
  }
  return false;
}

export async function resumePastSession(claudeSessionId: string): Promise<boolean> {
  try {
    const res = await api.transcripts.resume(claudeSessionId);
    const projects = await api.projects.list();
    const store = useAppStore.getState();
    store.setProjects(projects);
    await loadProjectChildren(res.projectId);
    store.expandProject(res.projectId);
    store.setSelectedProcess(res.sessionId);
    toast.success('Resumed agent');
    return true;
  } catch (err: any) {
    toast.error(err?.message || 'Failed to resume');
    return false;
  }
}

export async function resumePastCodexThread(threadId: string): Promise<boolean> {
  try {
    const res = await api.transcripts.resumeCodex(threadId);
    const projects = await api.projects.list();
    const store = useAppStore.getState();
    store.setProjects(projects);
    await loadProjectChildren(res.projectId);
    store.expandProject(res.projectId);
    store.setSelectedProcess(res.sessionId);
    toast.success('Resumed Codex thread');
    return true;
  } catch (err: any) {
    toast.error(err?.message || 'Failed to resume');
    return false;
  }
}

export async function createOrOpenProjectForCwd(cwdPath: string): Promise<boolean> {
  const store = useAppStore.getState();
  const existing = store.projects.find((p) => p.path.replace(/\/+$/, '') === cwdPath.replace(/\/+$/, ''));
  if (existing) {
    store.expandProject(existing.id);
    store.setProjectOverviewOpen(true);
    return true;
  }
  try {
    const project = await api.projects.create({ path: cwdPath });
    store.addProject(project);
    store.expandProject(project.id);
    store.setProjectOverviewOpen(true);
    toast.success(`Project "${project.name}" added`);
    return true;
  } catch (err: any) {
    const msg: string = err?.message || '';
    // 409 path: server says project already exists for this path. Refresh the
    // project list and route into the existing one rather than erroring.
    if (/already exists|duplicate|UNIQUE/i.test(msg)) {
      try {
        const projects = await api.projects.list();
        store.setProjects(projects);
        const found = projects.find((p) => p.path.replace(/\/+$/, '') === cwdPath.replace(/\/+$/, ''));
        if (found) {
          store.expandProject(found.id);
          store.setProjectOverviewOpen(true);
          return true;
        }
      } catch {}
    }
    toast.error(msg || 'Failed to add project');
    return false;
  }
}
