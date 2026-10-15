import type { RemoteFileEntry } from '../../../bindings/tinkerkit/models';
import { transformName } from '../../lib/name-transform.ts';
import { basename, normalizeRemotePath, remoteParent } from './paths.ts';

type RenameMode = 'prefix' | 'suffix' | 'replace' | 'custom';

export type RenameForm = { mode: RenameMode; value: string; find: string; replacement: string };

type RenamePreview = {
  source: string;
  target: string;
  status: 'ok' | 'empty' | 'invalid' | 'unchanged' | 'duplicate' | 'occupied';
};

function renameTargetName(name: string, form: RenameForm, isDirectory: boolean) {
  if (form.mode === 'suffix' && !isDirectory) {
    const dot = name.lastIndexOf('.');
    if (dot > 0) return transformName(name.slice(0, dot), form) + name.slice(dot);
  }
  return transformName(name, form);
}

export function buildRenamePreview(paths: string[], form: RenameForm, entries: RemoteFileEntry[]) {
  const sources = new Set(paths);
  const occupied = new Set(entries.map((entry) => entry.path));
  const directories = new Set(entries.filter((entry) => entry.isDir).map((entry) => entry.path));
  const targets = paths.map((source) => {
    const name = renameTargetName(basename(source), form, directories.has(source)).trim();
    return { name, path: normalizeRemotePath(`${remoteParent(source)}/${name}`) };
  });
  const counts = new Map<string, number>();
  for (const target of targets) counts.set(target.path, (counts.get(target.path) ?? 0) + 1);
  return paths.map((source, index): RenamePreview => {
    const target = targets[index];
    const status = !target.name
      ? 'empty'
      : target.name === '.' || target.name === '..' || /[\\/]/.test(target.name)
        ? 'invalid'
        : target.path === source
          ? 'unchanged'
          : (counts.get(target.path) ?? 0) > 1
            ? 'duplicate'
            : sources.has(target.path) || occupied.has(target.path)
              ? 'occupied'
              : 'ok';
    return { source, target: target.path, status };
  });
}
