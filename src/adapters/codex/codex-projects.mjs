import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { publicText } from './codex-state.mjs';

// Legacy desktop threads may not yet carry projectId. Match only registered
// project roots, never invent a project from an arbitrary cwd basename.
export async function addProjectNames(sessions, projects, canonicalize = realpath) {
  const cache = new Map();
  const canonical = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return Promise.resolve(null);
    if (!cache.has(value)) cache.set(value, Promise.resolve().then(() => canonicalize(value)).catch(() => path.normalize(value)));
    return cache.get(value);
  };
  const catalog = [];
  for (const project of projects) {
    if (typeof project?.id !== 'string' || typeof project.name !== 'string' || !project.name.trim()) continue;
    const roots = await Promise.all((Array.isArray(project.roots) ? project.roots : []).map(root => canonical(root?.path)));
    catalog.push({ id: project.id, name: publicText(project.name).trim().slice(0, 100), roots: roots.filter(Boolean) });
  }
  return Promise.all(sessions.map(async session => {
    let project;
    if (session.projectId) project = catalog.find(p => p.id === session.projectId);
    else {
      const directory = await canonical(session.directory); let longest = -1, ambiguous = false;
      if (directory) for (const candidate of catalog) for (const root of candidate.roots) {
        const relative = path.relative(root, directory);
        if (relative && (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep))) continue;
        if (root.length > longest) { project = candidate; longest = root.length; ambiguous = false; }
        else if (root.length === longest && project?.id !== candidate.id) ambiguous = true;
      }
      if (ambiguous) project = null;
    }
    return project?.name ? { ...session, projectId: project.id, projectName: project.name } : session;
  }));
}
