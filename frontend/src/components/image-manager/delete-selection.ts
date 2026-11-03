import type { DockerDeleteTarget, DockerImage } from '../../../bindings/tinkerkit/models';
import type { ImageRow } from './model';

export type ImageDeleteItem = {
  key: string;
  name: string;
  target: DockerDeleteTarget;
  digest: string;
  tags: string[];
};

function registryIdentity(image: DockerImage) {
  const digest = image.digest?.trim();
  return digest ? `${image.repository}\u0000${digest}` : '';
}

// 确认期间只使用此快照；后台镜像刷新不应改变 Tag 与待删除行的对应关系。
export function createImageDeleteItems(
  rows: ImageRow[],
  sourceKind: string,
  images: DockerImage[],
): ImageDeleteItem[] {
  const registry = sourceKind === 'registry';
  const selectedTags = new Set(rows.map((row) => row.reference).filter(Boolean));
  const associatedTags = new Map<string, Set<string>>();
  if (registry) {
    for (const image of images) {
      const identity = registryIdentity(image);
      if (!identity) continue;
      const tags = associatedTags.get(identity) ?? new Set<string>();
      for (const value of image.tags ?? []) {
        const tag = value.trim();
        if (tag && !selectedTags.has(tag)) tags.add(tag);
      }
      associatedTags.set(identity, tags);
    }
  }
  return rows.map((row) => {
    const digest = row.image.digest?.trim() ?? '';
    const tags = registry
      ? [...(associatedTags.get(registryIdentity(row.image)) ?? [])]
      : row.reference
        ? [row.reference]
        : [];
    return {
      key: row.key,
      name: row.reference || row.image.name?.trim() || '',
      // 具名行只移除所选 Tag，悬空镜像才按镜像 ID 删除整个镜像。
      target: { imageID: row.reference || row.image.id, expectedDigest: digest },
      digest: digest || (registry ? '' : row.image.id),
      tags: [...new Set(tags)],
    };
  });
}

export function imageDeletePreview(items: ImageDeleteItem[]) {
  const targets = new Map<string, DockerDeleteTarget>();
  for (const item of items) {
    if (!targets.has(item.target.imageID)) targets.set(item.target.imageID, item.target);
  }
  return {
    targets: [...targets.values()],
    digests: [...new Set(items.map((item) => item.digest).filter(Boolean))],
    tags: [...new Set(items.flatMap((item) => item.tags))],
  };
}

// 同一个 Registry Tag 可关联多条已勾选行，必须一起排除，避免仍从其它行删除该 manifest。
export function excludeImageDeleteTag(items: ImageDeleteItem[], tag: string) {
  const removedKeys = new Set(
    items.filter((item) => item.tags.includes(tag)).map((item) => item.key),
  );
  return {
    items: items.filter((item) => !removedKeys.has(item.key)),
    removedKeys,
  };
}
