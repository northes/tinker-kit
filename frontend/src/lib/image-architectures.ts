import type { DockerImage } from '../../bindings/tinkerkit/models';

// 列表只展示镜像自身架构：单架构直接给出架构名，多架构由调用方渲染为「多架构」。
// 读不到平台或只有占位架构（unknown）时返回空数组，不展示 badge。
export function imageArchitectures(image: Pick<DockerImage, 'platforms'>): string[] {
  return [
    ...new Set(
      (image.platforms ?? [])
        .map((platform) => platform.architecture)
        .filter((architecture) => architecture && architecture !== 'unknown'),
    ),
  ].sort();
}
