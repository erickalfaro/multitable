import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import simpleGit from 'simple-git';
import {
  getAllProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject,
  setProjectActive,
  getSessionsByProject,
  getCommandsByProject,
  getTerminalsByProject,
  createSession,
  createCommand,
  createTerminal,
} from '../db/store.js';
import type { GitWatcher } from '../git/watcher.js';
import {
  isGitRepo,
  isValidBranchName,
  branchExists,
  worktreePathFor,
  worktreeContainerFor,
  addWorktree,
  removeWorktree,
  removeSessionWorktree,
  deleteBranch,
} from '../git/index.js';
import { loadProjectConfig, loadGlobalConfig } from '../config/loader.js';
import { removeAttachmentDir } from './attachments.js';
import type { PtyManager } from '../pty/manager.js';
import type { AgentSessionManager } from '../agent/manager.js';
import type { ProcessConfig, SpawnConfig } from '../types.js';

// Ubuntu's VS Code snap injects GTK_PATH / LOCPATH / LD_LIBRARY_PATH that
// point into /snap/code/... When we spawn GUI tools like zenity from the
// daemon, they load a broken glibc from there and die with
// `symbol lookup error: ... __libc_pthread_init, version GLIBC_PRIVATE`.
// VS Code stashes the real values under `*_VSCODE_SNAP_ORIG` — restore them.
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (!key.endsWith('_VSCODE_SNAP_ORIG')) continue;
    const target = key.slice(0, -'_VSCODE_SNAP_ORIG'.length);
    const orig = env[key];
    if (orig && orig.length > 0) env[target] = orig;
    else delete env[target];
    delete env[key];
  }
  for (const key of ['LD_LIBRARY_PATH', 'GTK_PATH', 'LOCPATH', 'GIO_MODULE_DIR']) {
    const v = env[key];
    if (v && v.includes('/snap/')) delete env[key];
  }
  return env;
}

function runDialog(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedEnv(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const out = stdout.trim();
      if (!out && code && code !== 0 && code !== 1 && stderr.trim()) {
        console.warn(`folder picker ${cmd} exited ${code}: ${stderr.trim()}`);
      }
      resolve(out || null);
    });
  });
}

async function pickFolderDialog(): Promise<string | null> {
  const platform = process.platform;
  if (platform === 'darwin') {
    const script =
      'try\n  POSIX path of (choose folder with prompt "Select Project Folder")\non error\n  return ""\nend try';
    const p = await runDialog('osascript', ['-e', script]);
    return p ? p.replace(/\/+$/, '') : null;
  }
  if (platform === 'win32') {
    // Modern Explorer-style picker via IFileOpenDialog (FOS_PICKFOLDERS).
    // The legacy WinForms FolderBrowserDialog is kept as a catch-branch
    // fallback for ancient Windows boxes (PS < 5.1, .NET < 4.5).
    //
    // We base64-encode the script and pass it via `-EncodedCommand` to
    // sidestep the triple-nested quoting problem (Node string -> PowerShell
    // -> C# heredoc inside Add-Type). PowerShell expects UTF-16LE for
    // -EncodedCommand.
    const ps = `
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class MtFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
  public class FileOpenDialogRCW { }

  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOpenDialog {
    [PreserveSig] int Show([In] IntPtr parent);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex();
    void Advise(); void Unadvise();
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(); void SetFolder(); void GetFolder();
    void GetCurrentSelection();
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName(); void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel(); void SetFileNameLabel();
    void GetResult(out IShellItem ppsi);
    void AddPlace(); void SetDefaultExtension();
    void Close(); void SetClientGuid(); void ClearClientData();
    void SetFilter();
    void GetResults(); void GetSelectedItems();
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler();
    void GetParent();
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes();
    void Compare();
  }

  public static string Pick(string title) {
    var dlg = (IFileOpenDialog)(new FileOpenDialogRCW());
    // FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40
    dlg.SetOptions(0x20 | 0x40);
    if (title != null) dlg.SetTitle(title);
    int hr = dlg.Show(IntPtr.Zero);
    if (hr != 0) return null; // user cancelled or error
    IShellItem item;
    dlg.GetResult(out item);
    string path;
    // SIGDN_FILESYSPATH = 0x80058000
    item.GetDisplayName(0x80058000u, out path);
    return path;
  }
}
"@
  $p = [MtFolderPicker]::Pick("Select Project Folder")
  if ($p) { Write-Output $p }
} catch {
  # Fallback for very old PowerShell / .NET versions.
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  $f = New-Object System.Windows.Forms.FolderBrowserDialog
  $f.Description = 'Select Project Folder'
  if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }
}
`;
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    return runDialog('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-EncodedCommand',
      encoded,
    ]);
  }
  // linux / other unix
  try {
    return await runDialog('zenity', [
      '--file-selection',
      '--directory',
      '--title=Select Project Folder',
    ]);
  } catch {
    try {
      return await runDialog('kdialog', [
        '--getexistingdirectory',
        process.env.HOME || '.',
        '--title',
        'Select Project Folder',
      ]);
    } catch {
      throw new Error(
        'No native folder picker available. Install zenity or kdialog, or paste the path manually.',
      );
    }
  }
}

function defaultProcessConfig(overrides?: Partial<ProcessConfig>): ProcessConfig {
  return {
    autostart: false,
    autorestart: false,
    autorestartMax: 5,
    autorestartDelayMs: 2000,
    autorestartWindowSecs: 60,
    autorespawn: true,
    terminalAlerts: false,
    fileWatchPatterns: [],
    ...overrides,
  };
}

// File Viewer: cap on a single editable text file (read + write).
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
// File Viewer: cap on a single uploaded binary (matches the attachment cap).
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
// Top-level directories where uploads are flatly refused, even though the
// path-traversal check would otherwise let them through. .git would corrupt
// repo state; node_modules is package-manager territory. These mirror the
// File Viewer's listing-time hard exclude.
const UPLOAD_BLOCKED_TOPLEVEL = new Set(['.git', 'node_modules']);
// Directory entries always hidden from the File Viewer tree, even with ?all=1.
const FILE_TREE_HARD_EXCLUDE = new Set(['.git', 'node_modules']);

// express.raw() with the upload cap. Wraps the parser so a payload-too-large
// (or any other body-parser error) becomes a JSON response, matching the rest
// of the API rather than escaping to the default HTML error handler. Pattern
// mirrors `rawAttachmentBody` in api/attachments.ts.
const rawUploadParser = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });
function rawFileUploadBody(req: Request, res: Response, next: NextFunction): void {
  rawUploadParser(req, res, (err?: any) => {
    if (!err) return next();
    const status = typeof err.status === 'number' ? err.status : 400;
    res.status(status).json({ error: err.message || 'Invalid upload' });
  });
}

function safeDecodeHeader(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Strip path separators and control chars; preserve the extension verbatim
// (we don't trust MIME for the extension on free-form uploads). Returns null
// when the input would resolve to nothing safe.
function sanitizeUploadFilename(raw: string): string | null {
  if (!raw) return null;
  // Take only the basename to defeat `foo/../bar` style.
  const base = path.basename(raw);
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '') // strip control chars
    .replace(/[\\/]/g, '') // strip path separators (defensive)
    .replace(/[<>:"|?*]/g, '') // strip Windows-reserved chars
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  // Cap length; keep the trailing extension.
  if (cleaned.length <= 200) return cleaned;
  const ext = path.extname(cleaned);
  const stem = path.basename(cleaned, ext);
  return stem.slice(0, 200 - ext.length) + ext;
}

// Paginated File Viewer reads: never enumerate more than this many entries from a
// single directory, so a pathological dir (millions of files) can't hang the daemon.
// Sorting requires the full set, so this also bounds the sortable universe; beyond it
// the response is flagged `truncated`.
const MAX_DIR_ENTRIES = 10000;

export function createProjectsRouter(
  manager: PtyManager,
  gitWatcher: GitWatcher,
  agentManager: AgentSessionManager,
): Router {
  const router = Router();

  // GET /api/projects
  router.get('/', (_req: Request, res: Response) => {
    try {
      const projects = getAllProjects();
      res.json(projects);
    } catch (err) {
      res.status(500).json({ error: 'Failed to load projects' });
    }
  });

  // GET /api/projects/browse-dir?path= — lists subdirectories of an arbitrary
  // directory on the daemon host so a remote/mobile web client can pick a
  // project folder without the host-side native dialog. Must be registered
  // before `GET /:id`, or `browse-dir` is captured as `req.params.id`.
  //
  // Security: this lists arbitrary host directories over HTTP and deliberately
  // applies NO traversal guard — unlike `/:id/files`, the whole host FS is the
  // legitimate scope, since the user is choosing where their project lives. This
  // matches MultiTable's existing model: spawned agents already have full FS
  // read/write on the host, and the daemon binds only 127.0.0.1 + the trusted
  // Tailscale interface, never the public internet.
  router.get('/browse-dir', (req: Request, res: Response) => {
    const requested =
      typeof req.query.path === 'string' && req.query.path.trim()
        ? req.query.path
        : os.homedir();
    let resolved: string;
    try {
      resolved = path.resolve(requested);
    } catch {
      return res.status(400).json({ error: 'Invalid path' });
    }

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(resolved, { withFileTypes: true });
    } catch (err: any) {
      const code = err?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR')
        return res.status(404).json({ error: 'Directory not found' });
      if (code === 'EACCES' || code === 'EPERM')
        return res.status(403).json({ error: 'Permission denied' });
      return res.status(400).json({ error: err?.message || 'Failed to read directory' });
    }

    // Directories only — the picker never needs files, and skipping them means a
    // folder holding a huge number of files costs nothing extra (we never collect,
    // stat, or serialize them; only symlinks are stat'd to resolve their target).
    const entries: { name: string; path: string; type: 'directory' }[] = [];
    for (const dirent of dirents) {
      let isDir = dirent.isDirectory();
      if (!isDir && !dirent.isSymbolicLink()) continue;
      if (dirent.isSymbolicLink()) {
        // withFileTypes reports the symlink itself; stat to follow it so users
        // can navigate into symlinked directories. Skip dangling/broken links.
        try {
          isDir = fs.statSync(path.join(resolved, dirent.name)).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) entries.push({ name: dirent.name, path: path.join(resolved, dirent.name), type: 'directory' });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(resolved);
    const roots: { label: string; path: string }[] = [{ label: 'Home', path: os.homedir() }];
    if (process.platform === 'win32') {
      for (const letter of 'CDEFGHIJ') {
        const drive = `${letter}:\\`;
        try {
          if (fs.existsSync(drive)) roots.push({ label: drive, path: drive });
        } catch {
          /* ignore */
        }
      }
    } else {
      roots.push({ label: '/', path: '/' });
      if (process.platform === 'darwin' && fs.existsSync('/Volumes'))
        roots.push({ label: '/Volumes', path: '/Volumes' });
    }

    res.json({
      path: resolved,
      parent: parent === resolved ? null : parent,
      entries,
      roots,
    });
  });

  // POST /api/projects/browse-mkdir { parent, name } — creates a new folder on
  // the daemon host so a remote/mobile client can set up a fresh project
  // directory before adding it. Same host-FS scope/security note as browse-dir.
  router.post('/browse-mkdir', (req: Request, res: Response) => {
    const { parent, name } = req.body || {};
    if (typeof parent !== 'string' || !parent.trim())
      return res.status(400).json({ error: 'parent is required' });
    if (typeof name !== 'string' || !name.trim())
      return res.status(400).json({ error: 'name is required' });
    if (/[/\\]/.test(name) || name === '.' || name === '..')
      return res.status(400).json({ error: 'Invalid folder name' });

    const target = path.join(path.resolve(parent), name.trim());
    try {
      fs.mkdirSync(target, { recursive: false });
    } catch (err: any) {
      const code = err?.code;
      if (code === 'EEXIST')
        return res.status(409).json({ error: 'A folder with that name already exists' });
      if (code === 'EACCES' || code === 'EPERM')
        return res.status(403).json({ error: 'Permission denied' });
      if (code === 'ENOENT') return res.status(404).json({ error: 'Parent directory not found' });
      return res.status(400).json({ error: err?.message || 'Failed to create folder' });
    }
    res.status(201).json({ path: target });
  });

  // GET /api/projects/:id
  router.get('/:id', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

  // POST /api/projects/browse — opens the OS native folder picker and
  // returns the chosen absolute path. Returns `{ path: null }` if the
  // user cancelled. Must be registered before `/:id`-style routes.
  router.post('/browse', async (_req: Request, res: Response) => {
    try {
      const folder = await pickFolderDialog();
      res.json({ path: folder });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to open folder picker' });
    }
  });

  // POST /api/projects
  router.post('/', async (req: Request, res: Response) => {
    const { path: projectPath, shortcut, icon } = req.body || {};
    if (!projectPath) {
      return res.status(400).json({ error: 'path is required' });
    }
    const name = req.body.name || path.basename(projectPath.replace(/\/+$/, ''));
    let project;
    try {
      project = createProject({ name, path: projectPath, shortcut, icon });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) {
        return res.status(409).json({ error: 'A project with this path already exists' });
      }
      return res.status(500).json({ error: 'Failed to create project' });
    }

    // Legacy webhook hooks are retired. The SDK's in-process hook callbacks
    // cover everything we used to install into .claude/settings.json, so
    // creating a project no longer touches that file.

    // Start watching the working tree for live git status updates.
    gitWatcher.watch(project.id, project.path);

    res.status(201).json(project);
  });

  // PUT /api/projects/:id
  router.put('/:id', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { name, shortcut, icon } = req.body || {};
    const updated = updateProject(req.params.id, { name, shortcut, icon });
    res.json(updated);
  });

  // DELETE /api/projects/:id
  router.delete('/:id', async (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Tear down all child processes before the cascade deletes their rows.
    const sessions = getSessionsByProject(req.params.id);
    const commands = getCommandsByProject(req.params.id);
    const terminals = getTerminalsByProject(req.params.id);
    for (const child of [...sessions, ...commands, ...terminals]) {
      try { manager.remove(child.id); } catch { /* best effort */ }
      try { agentManager.remove(child.id); } catch { /* best effort */ }
    }

    // Clean up attachments dirs for the children. Only sessions/terminals can
    // have attachments, but removeAttachmentDir is a no-op for missing dirs.
    for (const child of [...sessions, ...terminals]) {
      removeAttachmentDir(child.id);
    }

    // Stop git status watcher before the row is removed.
    gitWatcher.unwatch(req.params.id);

    // Worktree teardown for worktree-backed sessions (same remove-if-clean
    // policy as the single-session DELETE; dirty worktrees are kept so the
    // uncommitted work survives the project delete).
    for (const session of sessions) {
      if (!session.worktreePath) continue;
      gitWatcher.unwatchSession(session.id);
      try {
        await removeSessionWorktree(project.path, session.worktreePath);
      } catch { /* best effort */ }
    }
    // Drop the sibling container dir once it's empty (best effort).
    try {
      const container = worktreeContainerFor(project.path);
      if (fs.existsSync(container) && fs.readdirSync(container).length === 0) {
        fs.rmdirSync(container);
      }
    } catch {}

    // Cascades to sessions/commands/terminals/session_events/cost_records.
    deleteProject(req.params.id);
    res.status(204).send();
  });

  // POST /api/projects/:id/active
  router.post('/:id/active', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { active } = req.body || {};
    setProjectActive(req.params.id, active !== false);
    res.json({ ok: true });
  });

  // GET /api/projects/:id/config
  router.get('/:id/config', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const config = loadProjectConfig(project.path);
    res.json(config || {});
  });

  // GET /api/projects/:id/sessions
  router.get('/:id/sessions', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const sessions = getSessionsByProject(req.params.id);
    // Match the shape of /api/sessions and /api/sessions/:id so the web client
    // sees capabilities / mode / thinkingEffort on initial load. Without them,
    // ModeBadge stays hidden until a later syncSession() lands (selection /
    // running-state triggers it), producing a "the chip appears after I
    // interact with the page" UX bug.
    const enriched = sessions.map((s) => {
      const agent = agentManager.get(s.id);
      const capabilities = agentManager.getCapabilities(s.id);
      return {
        ...s,
        state: agent?.state ?? 'stopped',
        pid: null,
        mode: agent?.mode ?? s.mode ?? 'default',
        thinkingEffort: agent?.thinkingEffort ?? s.thinkingEffort ?? null,
        capabilities,
      };
    });
    res.json(enriched);
  });

  // GET /api/projects/:id/commands
  router.get('/:id/commands', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const commands = getCommandsByProject(req.params.id);
    const enriched = commands.map((c) => {
      const proc = manager.get(c.id);
      return { ...c, state: proc?.state ?? 'stopped', pid: proc?.pid ?? null };
    });
    res.json(enriched);
  });

  // GET /api/projects/:id/terminals
  router.get('/:id/terminals', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const terminals = getTerminalsByProject(req.params.id);
    const enriched = terminals.map((t) => {
      const proc = manager.get(t.id);
      return { ...t, state: proc?.state ?? 'stopped', pid: proc?.pid ?? null };
    });
    res.json(enriched);
  });

  // POST /api/projects/:id/sessions — create a session under a project
  router.post('/:id/sessions', async (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const {
      name,
      command,
      workingDirectory,
      autostart,
      autorestart,
      autorespawn,
      terminalAlerts,
      fileWatchPatterns,
      agentProvider,
      model,
      mode,
      worktree,
    } = req.body || {};
    if (!name || !command) {
      return res.status(400).json({ error: 'name and command are required' });
    }

    // Optional isolated git worktree. Created on disk BEFORE the DB insert and
    // before provisionSession — provider children bind to the session cwd at
    // provision time, so the directory must already exist. Any git failure
    // fails the whole request; no session row is left behind.
    let worktreePath: string | null = null;
    let worktreeBranch: string | null = null;
    if (worktree) {
      if (!isGitRepo(project.path)) {
        return res.status(400).json({ error: 'Project is not a git repository' });
      }
      const branch = typeof worktree.branch === 'string' ? worktree.branch.trim() : '';
      if (!branch) {
        return res.status(400).json({ error: 'worktree.branch is required' });
      }
      if (!(await isValidBranchName(project.path, branch))) {
        return res.status(400).json({ error: `Invalid branch name: ${branch}` });
      }
      if (await branchExists(project.path, branch)) {
        return res.status(409).json({ error: `Branch already exists: ${branch}` });
      }
      const wtPath = worktreePathFor(project.path, branch);
      if (fs.existsSync(wtPath)) {
        return res.status(409).json({ error: `Worktree directory already exists: ${wtPath}` });
      }
      try {
        await addWorktree(project.path, wtPath, branch);
      } catch (err) {
        // git's own stderr (in err.message) is the useful diagnostic here.
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ error: `Failed to create worktree: ${msg}` });
      }
      worktreePath = wtPath;
      worktreeBranch = branch;
    }

    try {
      const provider: 'claude' | 'codex' | 'hermes' | 'grok' | 'cursor' | undefined =
        agentProvider === 'claude' ||
        agentProvider === 'codex' ||
        agentProvider === 'hermes' ||
        agentProvider === 'grok' ||
        agentProvider === 'cursor'
          ? agentProvider
          : undefined;
      const modelId =
        typeof model === 'string' && model.trim().length > 0 ? model.trim() : null;
      // Seed thinking effort from the user's last choice so newly-created
      // sessions inherit the sticky default. Falls back to 'medium' the first
      // time anyone uses the feature. (GlobalConfig.lastThinkingEffort is
      // updated by the /:id/thinking-effort endpoint on every flip.)
      const cfg = loadGlobalConfig();
      const seedEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' =
        cfg.lastThinkingEffort ?? 'medium';
      const session = createSession({
        projectId: req.params.id,
        name,
        command,
        workingDirectory: worktreePath ?? (workingDirectory || project.path),
        worktreePath,
        worktreeBranch,
        type: 'session',
        autostart,
        autorestart,
        autorespawn,
        terminalAlerts,
        fileWatchPatterns,
        agentProvider: provider,
        model: modelId,
        thinkingEffort: seedEffort,
        mode: typeof mode === 'string' && mode.trim().length > 0 ? mode.trim() : undefined,
      });
      // Register in the agent manager so the next session:send doesn't race
      // the DB write, and so capabilities are available for the response.
      agentManager.register({
        id: session.id,
        projectId: session.projectId,
        name: session.name,
        // Falling back to project.path matches the boot-time register in
        // index.ts and the other register sites below. An empty workingDir
        // gets passed through to provider adapters and ends up as the agent
        // child's `os.getcwd()` (in Hermes' case, the daemon's cwd —
        // `packages/daemon` under `npm run dev -w` — which breaks per-session
        // shell tools).
        workingDir: session.workingDirectory || project.path,
        provider: session.agentProvider,
        model: session.model,
        mode: session.mode,
        thinkingEffort: session.thinkingEffort,
        agentSessionId: session.agentSessionId ?? null,
        agentSessionIdHistory: session.agentSessionIdHistory ?? [],
        claudeSessionId: session.claudeSessionId ?? null,
        claudeSessionIdHistory: session.claudeSessionIdHistory ?? [],
      });
      // Stream git status for the worktree so the session's branch/dirty
      // indicator stays live (broadcast as git:session-status-changed).
      if (worktreePath) {
        gitWatcher.watchSession(session.id, worktreePath);
      }
      // Mint the provider-side session id BEFORE returning. The cold-start
      // cost (codex `thread/start` RPC ~500ms–2s; warmup at boot has already
      // paid for the app-server spawn) happens here instead of on the user's
      // first message, so the chat is fully primed the moment the modal
      // closes. Errors are swallowed inside provisionSession (logged, not
      // thrown) — falling back to lazy mint on first turn is acceptable.
      await agentManager.provisionSession(session.id);
      // Enrich the response so the web store has `capabilities` immediately —
      // the ModeBadge dropdown self-hides when modes.length <= 1, and would
      // stay hidden on a freshly created session if we returned the bare DB
      // row. Mirrors the GET /api/sessions/:id shape.
      const agent = agentManager.get(session.id);
      const capabilities = agentManager.getCapabilities(session.id);
      res.status(201).json({
        ...session,
        state: agent?.state ?? 'stopped',
        pid: null,
        mode: agent?.mode ?? session.mode ?? 'default',
        capabilities,
      });
    } catch (err) {
      // The session never came to life — roll the worktree (and its branch)
      // back so a retry with the same name doesn't 409. "Branch always kept"
      // applies to deleting a real session, not to a failed create.
      if (worktreePath && worktreeBranch) {
        try {
          await removeWorktree(project.path, worktreePath);
          await deleteBranch(project.path, worktreeBranch, true);
        } catch {}
      }
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // POST /api/projects/:id/commands — create a command under a project
  router.post('/:id/commands', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { name, command, workingDirectory, autostart, autorestart, terminalAlerts, fileWatchPatterns } = req.body || {};
    if (!command) {
      return res.status(400).json({ error: 'command is required' });
    }

    try {
      const record = createCommand({
        projectId: req.params.id,
        name: name || command,
        command,
        workingDirectory: workingDirectory || project.path,
        autostart,
        autorestart,
        terminalAlerts,
        fileWatchPatterns,
      });
      res.status(201).json(record);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create command' });
    }
  });

  // POST /api/projects/:id/terminals — create a terminal under a project
  router.post('/:id/terminals', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { name, shell, workingDirectory } = req.body || {};

    // Auto-name: "Terminal N"
    const existing = getTerminalsByProject(req.params.id);
    const autoName = name || `Terminal ${existing.length + 1}`;
    const termShell = shell || process.env.SHELL || 'bash';

    try {
      const record = createTerminal({
        projectId: req.params.id,
        name: autoName,
        shell: termShell,
        workingDirectory: workingDirectory || project.path,
      });

      // Spawn PTY immediately
      const spawnCfg: SpawnConfig = {
        id: record.id,
        name: autoName,
        command: termShell,
        workingDir: workingDirectory || project.path,
        type: 'terminal',
        projectId: req.params.id,
        config: defaultProcessConfig({ autorespawn: false }),
      };
      const proc = manager.spawn(spawnCfg);

      res.status(201).json({
        ...record,
        state: 'running',
        pid: proc.pid,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create terminal' });
    }
  });

  // GET /api/projects/:id/files?path=
  router.get('/:id/files', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const relPath = (req.query.path as string) || '';
    // Normalize project.path to remove any trailing slashes for consistent comparison
    const normalizedProjectPath = path.resolve(project.path);
    const resolved = path.resolve(normalizedProjectPath, relPath);

    // Prevent directory traversal
    if (!resolved.startsWith(normalizedProjectPath)) {
      return res.status(403).json({ error: 'Path is outside project directory' });
    }

    // ?all=1 exposes dotfolders (.claude/, .github/, …) for the File Viewer;
    // other callers (Files tab, @-mention index) omit it and keep the old
    // dotfile-hiding behavior.
    const includeAll = req.query.all === '1' || req.query.all === 'true';

    const keep = (name: string) => {
      if (FILE_TREE_HARD_EXCLUDE.has(name)) return false;
      if (includeAll) return true;
      return !name.startsWith('.');
    };
    const sortEntries = (a: { name: string; type: string }, b: { name: string; type: string }) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'directory' ? -1 : 1;
    };

    // ?limit present → paginated, memory-bounded read for the File Viewer tree.
    // Callers that omit it (e.g. the @-mention index) keep the legacy plain-array
    // response below.
    const hasLimit = req.query.limit !== undefined;
    if (hasLimit) {
      const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      let dir: fs.Dir | null = null;
      try {
        // Stream dirents (name + type, no per-entry stat) up to a hard cap so even a
        // directory with millions of entries can't blow up memory or hang. Sorting
        // needs the whole set, so the cap also bounds the sortable universe.
        dir = fs.opendirSync(resolved);
        const collected: { name: string; path: string; type: 'directory' | 'file' }[] = [];
        let truncated = false;
        for (let dirent = dir.readSync(); dirent !== null; dirent = dir.readSync()) {
          if (!keep(dirent.name)) continue;
          if (collected.length >= MAX_DIR_ENTRIES) {
            truncated = true;
            break;
          }
          collected.push({
            name: dirent.name,
            path: relPath ? `${relPath}/${dirent.name}` : dirent.name,
            type: dirent.isDirectory() ? 'directory' : 'file',
          });
        }
        collected.sort(sortEntries);
        const page = collected.slice(offset, offset + limit);
        // Stat only the visible page (≤ limit) for size/modifiedAt.
        const entries = page.map((e) => {
          try {
            const stat = fs.statSync(path.join(resolved, e.name));
            return { ...e, size: stat.size, modifiedAt: stat.mtimeMs };
          } catch {
            return { ...e, size: 0, modifiedAt: 0 };
          }
        });
        return res.json({
          entries,
          total: collected.length,
          offset,
          limit,
          hasMore: offset + entries.length < collected.length,
          truncated,
        });
      } catch (err: any) {
        return res.status(400).json({ error: err.message || 'Failed to read directory' });
      } finally {
        try {
          dir?.closeSync();
        } catch {
          /* already closed / never opened */
        }
      }
    }

    try {
      const entries = fs.readdirSync(resolved);
      const result = entries
        .filter(keep)
        .map((name) => {
          try {
            const fullPath = path.join(resolved, name);
            const stat = fs.statSync(fullPath);
            const entryRelPath = relPath ? `${relPath}/${name}` : name;
            return {
              name,
              path: entryRelPath,
              type: stat.isDirectory() ? 'directory' : 'file',
              size: stat.size,
              modifiedAt: stat.mtimeMs,
            };
          } catch {
            const entryRelPath = relPath ? `${relPath}/${name}` : name;
            return { name, path: entryRelPath, type: 'file', size: 0, modifiedAt: 0 };
          }
        })
        .sort(sortEntries);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to read directory' });
    }
  });

  // GET /api/projects/:id/file-content?path= — read a single text file for the
  // File Viewer. Missing file → { content:'', exists:false } (200) so the
  // editor can open a not-yet-created path gracefully.
  router.get('/:id/file-content', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const relPath = (req.query.path as string) || '';
    if (!relPath) return res.status(400).json({ error: 'path is required' });

    const normalizedProjectPath = path.resolve(project.path);
    const resolved = path.resolve(normalizedProjectPath, relPath);
    if (!resolved.startsWith(normalizedProjectPath)) {
      return res.status(403).json({ error: 'Path is outside project directory' });
    }

    try {
      if (!fs.existsSync(resolved)) {
        return res.json({ content: '', exists: false });
      }
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is a directory' });
      }
      if (stat.size > MAX_TEXT_BYTES) {
        return res.status(413).json({ error: 'File too large to edit (2 MB limit)' });
      }
      const buf = fs.readFileSync(resolved);
      const scanLen = Math.min(buf.length, 8000);
      for (let i = 0; i < scanLen; i++) {
        if (buf[i] === 0) {
          return res.status(415).json({ error: 'Binary file — not editable' });
        }
      }
      res.json({
        content: buf.toString('utf8'),
        exists: true,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to read file' });
    }
  });

  // POST /api/projects/:id/file-content { path, content } — save a single text
  // file for the File Viewer (creates parent dirs; atomic temp+rename).
  router.post('/:id/file-content', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { path: relPath, content } = req.body || {};
    if (typeof relPath !== 'string' || !relPath.trim()) {
      return res.status(400).json({ error: 'path is required' });
    }
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const normalizedProjectPath = path.resolve(project.path);
    const resolved = path.resolve(normalizedProjectPath, relPath);
    if (!resolved.startsWith(normalizedProjectPath)) {
      return res.status(403).json({ error: 'Path is outside project directory' });
    }

    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return res.status(400).json({ error: 'Path is a directory' });
      }
      const dirPath = path.dirname(resolved);
      fs.mkdirSync(dirPath, { recursive: true });
      const tmp = `${resolved}.mt-tmp-${Date.now()}`;
      try {
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, resolved);
      } catch (e) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
          /* best-effort temp cleanup */
        }
        throw e;
      }
      const stat = fs.statSync(resolved);
      res.json({ ok: true, path: relPath, size: stat.size, modifiedAt: stat.mtimeMs });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to write file' });
    }
  });

  // POST /api/projects/:id/file-upload — upload one binary file into the
  // project tree. Raw-body upload (matches the attachment endpoint pattern in
  // api/attachments.ts) so we can carry any MIME type without multipart
  // overhead, and so a mobile browser over Tailscale just uses a stock
  // <input type="file">. One file per request — the client loops for batches.
  //
  // Headers:
  //   X-Filename   URI-encoded original filename (required)
  //   X-Target-Dir URI-encoded folder relative to project root (optional,
  //                empty = root)
  // Response: 201 { ok: true, path, size, modifiedAt }
  // Conflict policy: 409 if the target file already exists (no overwrite,
  // no auto-rename — see plan).
  router.post('/:id/file-upload', rawFileUploadBody, (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const body = req.body;
    if (!body || !Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'Empty upload' });
    }
    // Defense in depth — the parser also enforces this, but the parser's
    // error wrapper returns its own JSON before reaching here.
    if (body.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: 'File too large' });
    }

    const filenameHeader = req.headers['x-filename'];
    const rawName =
      typeof filenameHeader === 'string' ? safeDecodeHeader(filenameHeader) : '';
    const filename = sanitizeUploadFilename(rawName);
    if (!filename) {
      return res.status(400).json({ error: 'X-Filename header is required' });
    }

    const targetDirHeader = req.headers['x-target-dir'];
    const rawTargetDir =
      typeof targetDirHeader === 'string' ? safeDecodeHeader(targetDirHeader) : '';
    const targetDir = rawTargetDir.trim();

    // Mirror the file-content write check: reject absolute paths and any
    // segment that's `..`. Empty string means "project root", which is fine.
    if (targetDir) {
      if (path.isAbsolute(targetDir) || targetDir.split(/[\\/]/).includes('..')) {
        return res.status(400).json({ error: 'Invalid target directory' });
      }
      // Explicit hard-block for the same toplevel dirs the file listing hides:
      // writing into .git/** would corrupt repo state, and node_modules is
      // package-manager territory.
      const firstSegment = targetDir.split(/[\\/]/).filter(Boolean)[0];
      if (firstSegment && UPLOAD_BLOCKED_TOPLEVEL.has(firstSegment)) {
        return res.status(403).json({ error: `Uploads into ${firstSegment} are not allowed` });
      }
    }

    const normalizedProjectPath = path.resolve(project.path);
    const targetDirResolved = targetDir
      ? path.resolve(normalizedProjectPath, targetDir)
      : normalizedProjectPath;
    if (!targetDirResolved.startsWith(normalizedProjectPath)) {
      return res.status(403).json({ error: 'Target is outside project directory' });
    }
    const fullPath = path.join(targetDirResolved, filename);
    const fullResolved = path.resolve(fullPath);
    if (!fullResolved.startsWith(normalizedProjectPath)) {
      return res.status(403).json({ error: 'Target is outside project directory' });
    }

    // Conflict policy: refuse rather than overwrite. The client surfaces this
    // as a per-file toast so the user can rename or delete and retry.
    if (fs.existsSync(fullResolved)) {
      const relConflict = path.relative(normalizedProjectPath, fullResolved);
      return res.status(409).json({ error: 'File already exists', path: relConflict });
    }
    // If something with the same name exists but is a directory, the existsSync
    // above is true so we already returned 409. The check below catches the
    // edge case where the *target dir* path collides with an existing file.
    try {
      if (fs.existsSync(targetDirResolved) && !fs.statSync(targetDirResolved).isDirectory()) {
        return res.status(400).json({ error: 'Target path is not a directory' });
      }
    } catch {
      /* fall through — mkdir below will surface the real error */
    }

    try {
      fs.mkdirSync(targetDirResolved, { recursive: true });
      const tmp = `${fullResolved}.mt-tmp-${Date.now()}`;
      try {
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, fullResolved);
      } catch (e) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
          /* best-effort temp cleanup */
        }
        throw e;
      }
      const stat = fs.statSync(fullResolved);
      const relPath = path.relative(normalizedProjectPath, fullResolved);
      res.status(201).json({
        ok: true,
        path: relPath,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to write upload' });
    }
  });

  // POST /api/projects/:id/open-file
  router.post('/:id/open-file', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { path: filePath } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'path is required' });

    const resolved = path.resolve(project.path, filePath);
    const globalConfig = loadGlobalConfig();
    const editor = globalConfig.defaultEditor || 'code';

    // Fire and forget
    const child = spawn(editor, [resolved], { detached: true, stdio: 'ignore' });
    child.unref();

    res.json({ ok: true });
  });

  // GET /api/projects/:id/slash-commands — discover Claude Code custom slash
  // commands from `.claude/commands/*.md` (project) and `~/.claude/commands/*.md`
  // (user-global). Markdown frontmatter `description:` is surfaced in the
  // composer's autocomplete; the file's body is the prompt template the SDK
  // will run when the command is invoked.
  router.get('/:id/slash-commands', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const home = process.env.HOME || process.env.USERPROFILE || '';
    const dirs: Array<{ dir: string; scope: 'project' | 'user' }> = [
      { dir: path.join(project.path, '.claude', 'commands'), scope: 'project' },
    ];
    if (home) dirs.push({ dir: path.join(home, '.claude', 'commands'), scope: 'user' });

    interface SlashCmd { name: string; scope: 'project' | 'user'; description: string }
    const out: SlashCmd[] = [];
    const seen = new Set<string>();

    for (const { dir, scope } of dirs) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      } catch {
        continue;
      }
      for (const file of entries) {
        const name = '/' + file.replace(/\.md$/, '');
        if (seen.has(name)) continue;  // project shadows user
        seen.add(name);
        let description = '';
        try {
          const content = fs.readFileSync(path.join(dir, file), 'utf8');
          // Look for `description:` in the YAML frontmatter (between leading ---).
          const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const dm = fmMatch[1].match(/^description:\s*(.+)$/m);
            if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '');
          }
          // Fallback: first non-frontmatter, non-empty line.
          if (!description) {
            const body = fmMatch ? content.slice(fmMatch[0].length) : content;
            description = (body.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 80);
          }
        } catch {}
        out.push({ name, scope, description });
      }
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ commands: out });
  });

  // GET /api/projects/:id/diff
  router.get('/:id/diff', async (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
      const git = simpleGit(project.path);
      const diff = await git.diff();
      res.json({ diff });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get diff' });
    }
  });

  // POST /api/projects/:id/start-all
  router.post('/:id/start-all', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const sessions = getSessionsByProject(req.params.id);
    const commands = getCommandsByProject(req.params.id);
    const terminals = getTerminalsByProject(req.params.id);
    const started: string[] = [];

    for (const session of sessions) {
      if (!manager.get(session.id) || manager.get(session.id)?.state === 'stopped') {
        try {
          const spawnCfg: SpawnConfig = {
            id: session.id,
            name: session.name,
            command: session.command,
            workingDir: session.workingDirectory || project.path,
            type: 'session',
            projectId: project.id,
            config: defaultProcessConfig({
              autostart: session.autostart,
              autorestart: session.autorestart,
              autorestartMax: session.autorestartMax,
              autorestartDelayMs: session.autorestartDelayMs,
              autorestartWindowSecs: session.autorestartWindowSecs,
              autorespawn: session.autorespawn,
              terminalAlerts: session.terminalAlerts,
              fileWatchPatterns: session.fileWatchPatterns,
            }),
          };
          manager.spawn(spawnCfg);
          started.push(session.id);
        } catch {}
      }
    }

    for (const cmd of commands) {
      if (!manager.get(cmd.id) || manager.get(cmd.id)?.state === 'stopped') {
        try {
          const spawnCfg: SpawnConfig = {
            id: cmd.id,
            name: cmd.name,
            command: cmd.command,
            workingDir: cmd.workingDirectory || project.path,
            type: 'command',
            projectId: project.id,
            config: defaultProcessConfig({
              autostart: cmd.autostart,
              autorestart: cmd.autorestart,
              autorestartMax: cmd.autorestartMax,
              autorestartDelayMs: cmd.autorestartDelayMs,
              autorestartWindowSecs: cmd.autorestartWindowSecs,
              terminalAlerts: cmd.terminalAlerts,
              fileWatchPatterns: cmd.fileWatchPatterns,
            }),
          };
          manager.spawn(spawnCfg);
          started.push(cmd.id);
        } catch {}
      }
    }

    for (const term of terminals) {
      if (!manager.get(term.id) || manager.get(term.id)?.state === 'stopped') {
        try {
          const termShell = term.shell || process.env.SHELL || 'bash';
          const spawnCfg: SpawnConfig = {
            id: term.id,
            name: term.name,
            command: termShell,
            workingDir: term.workingDirectory || project.path,
            type: 'terminal',
            projectId: project.id,
            config: defaultProcessConfig({
              autorespawn: false,
            }),
          };
          manager.spawn(spawnCfg);
          started.push(term.id);
        } catch {}
      }
    }

    res.json({ started });
  });

  // POST /api/projects/:id/stop-all
  router.post('/:id/stop-all', (req: Request, res: Response) => {
    const project = getProjectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const sessions = getSessionsByProject(req.params.id);
    const commands = getCommandsByProject(req.params.id);
    const terminals = getTerminalsByProject(req.params.id);
    const stopped: string[] = [];

    for (const s of [...sessions, ...commands, ...terminals]) {
      const proc = manager.get(s.id);
      if (proc && proc.state === 'running') {
        manager.kill(s.id);
        stopped.push(s.id);
      }
    }

    res.json({ stopped });
  });

  return router;
}
