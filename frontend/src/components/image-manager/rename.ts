import { transformName } from '../../lib/name-transform.ts';
import type { ImageRow } from './model';

export type ImageRenameScope = 'tag' | 'name';

type ImageRenameMode = 'prefix' | 'suffix' | 'replace' | 'custom';

export type ImageRenameForm = {
  scope: ImageRenameScope;
  mode: ImageRenameMode;
  value: string;
  find: string;
  replacement: string;
};

type ImageRenamePreview = {
  source: string;
  target: string;
  status: 'ok' | 'empty' | 'unchanged' | 'duplicate' | 'crossRepository';
};

export function imageRepository(reference: string) {
  const lastSlash = reference.lastIndexOf('/');
  const lastColon = reference.lastIndexOf(':');
  return lastColon > lastSlash ? reference.slice(0, lastColon) : reference;
}

export function imageTag(reference: string) {
  const repository = imageRepository(reference);
  return repository === reference ? '' : reference.slice(repository.length + 1);
}

// 作用对象为 Tag 时只改最后一个冒号后的部分，其余情况作用于完整镜像名。
function imageRenameTarget(reference: string, form: ImageRenameForm) {
  if (form.scope === 'name') {
    return transformName(reference, form);
  }
  const repository = imageRepository(reference);
  const nextTag = transformName(imageTag(reference), form);
  return nextTag ? `${repository}:${nextTag}` : reference;
}

export function renameFormHasInput(form: ImageRenameForm) {
  return form.mode === 'replace' ? form.find.length > 0 : form.value.length > 0;
}

// 预览同时标记空目标、未变化、跨行重复和 Registry 跨仓库，提交前即可发现非法重命名。
export function buildRenamePreview(
  rows: ImageRow[],
  form: ImageRenameForm,
  sameRepositoryRequired: boolean,
): ImageRenamePreview[] {
  const targets = rows.map((row) => imageRenameTarget(row.reference, form).trim());
  const counts = new Map<string, number>();
  for (const target of targets) counts.set(target, (counts.get(target) ?? 0) + 1);
  return rows.map((row, index) => {
    const source = row.reference;
    const target = targets[index];
    const status: ImageRenamePreview['status'] = !target
      ? 'empty'
      : target === source
        ? 'unchanged'
        : (counts.get(target) ?? 0) > 1
          ? 'duplicate'
          : sameRepositoryRequired && imageRepository(target) !== imageRepository(source)
            ? 'crossRepository'
            : 'ok';
    return { source, target, status };
  });
}
