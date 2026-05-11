import { Router } from 'express';
import type { Request, Response } from 'express';
import type { PtyManager } from '../pty/manager.js';

export function createProcessesRouter(manager: PtyManager): Router {
  const router = Router();

  // GET /api/processes — list all running processes
  router.get('/', (_req: Request, res: Response) => {
    const procs = manager.getAll().map((p) => ({
      id: p.id,
      name: p.name,
      command: p.command,
      workingDir: p.workingDir,
      type: p.type,
      projectId: p.projectId,
      state: p.state,
      pid: p.pid,
      startedAt: p.startedAt,
      restartCount: p.restartCount,
      metrics: p.metrics,
    }));
    res.json(procs);
  });

  // GET /api/processes/:id
  router.get('/:id', (req: Request, res: Response) => {
    const proc = manager.get(req.params.id);
    if (!proc) return res.status(404).json({ error: 'Process not found' });
    res.json({
      id: proc.id,
      name: proc.name,
      command: proc.command,
      workingDir: proc.workingDir,
      type: proc.type,
      projectId: proc.projectId,
      state: proc.state,
      pid: proc.pid,
      startedAt: proc.startedAt,
      restartCount: proc.restartCount,
      metrics: proc.metrics,
    });
  });

  // POST /api/processes/:id/start
  router.post('/:id/start', (req: Request, res: Response) => {
    const proc = manager.get(req.params.id);
    if (!proc) return res.status(404).json({ error: 'Process not found' });
    if (proc.state === 'running') {
      return res.status(409).json({ error: 'Process is already running' });
    }
    manager.forceSpawn(req.params.id, req.body?.cols, req.body?.rows);
    res.json({ ok: true });
  });

  // POST /api/processes/:id/stop
  router.post('/:id/stop', (req: Request, res: Response) => {
    const proc = manager.get(req.params.id);
    if (!proc) return res.status(404).json({ error: 'Process not found' });
    manager.kill(req.params.id);
    res.json({ ok: true });
  });

  // POST /api/processes/:id/restart
  router.post('/:id/restart', (req: Request, res: Response) => {
    const proc = manager.get(req.params.id);
    if (!proc) return res.status(404).json({ error: 'Process not found' });
    manager.restart(req.params.id);
    res.json({ ok: true });
  });

  // POST /api/processes/:id/resize
  router.post('/:id/resize', (req: Request, res: Response) => {
    const proc = manager.get(req.params.id);
    if (!proc) return res.status(404).json({ error: 'Process not found' });
    const { cols, rows } = req.body || {};
    if (!cols || !rows) return res.status(400).json({ error: 'cols and rows are required' });
    manager.resize(req.params.id, cols, rows);
    res.json({ ok: true });
  });

  // POST /api/processes/:id/input
  router.post('/:id/input', (req: Request, res: Response) => {
    const proc = manager.get(req.params.id);
    if (!proc) return res.status(404).json({ error: 'Process not found' });
    const { data } = req.body || {};
    if (data === undefined) return res.status(400).json({ error: 'data is required' });
    manager.write(req.params.id, data);
    res.json({ ok: true });
  });

  // DELETE /api/processes/:id/scrollback — clear scrollback buffer
  router.delete('/:id/scrollback', (req: Request, res: Response) => {
    const proc = manager.get(req.params.id);
    if (!proc) return res.status(404).json({ error: 'Process not found' });
    proc.outputBuffer.clear();
    res.json({ ok: true });
  });

  // DELETE /api/processes/:id — remove from manager
  router.delete('/:id', (req: Request, res: Response) => {
    const proc = manager.get(req.params.id);
    if (!proc) return res.status(404).json({ error: 'Process not found' });
    manager.remove(req.params.id);
    res.status(204).send();
  });

  return router;
}
