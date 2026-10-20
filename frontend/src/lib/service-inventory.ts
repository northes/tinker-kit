import type { ServiceInventory } from '../../bindings/tinkerkit/models';

// 只有成功的查询才能替换对应资源；失败保留快照并携带本次错误。
export function mergeServiceInventory(
  previous: ServiceInventory | null | undefined,
  next: ServiceInventory,
): ServiceInventory {
  if (!previous || previous.target.id !== next.target.id) return next;
  const docker = next.docker.available ? next : previous;
  const pm2 = next.pm2.available ? next : previous;
  const systemUnits = ['system', 'user'].flatMap((scope) => {
    const status = scope === 'system' ? next.systemdSystem : next.systemdUser;
    return ((status.available ? next : previous).systemUnits ?? []).filter(
      (unit) => unit.scope === scope,
    );
  });
  return {
    ...next,
    docker: { ...next.docker, available: next.docker.available || previous.docker.available },
    pm2: { ...next.pm2, available: next.pm2.available || previous.pm2.available },
    systemd: { ...next.systemd, available: next.systemd.available || previous.systemd.available },
    dockerGroups: docker.dockerGroups,
    containers: docker.containers,
    pm2Processes: pm2.pm2Processes,
    systemUnits,
  };
}
