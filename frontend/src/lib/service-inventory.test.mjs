import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeServiceInventory } from './service-inventory.ts';
const status = (available = true, error = '') => ({ available, error });
const snapshot = () => ({
  target: { id: 'host' },
  docker: status(),
  pm2: status(),
  systemd: status(),
  systemdSystem: status(),
  systemdUser: status(),
  containers: [{ id: 'container' }],
  dockerGroups: [],
  pm2Processes: [{ id: 'process' }],
  systemUnits: [
    { id: 'system', scope: 'system' },
    { id: 'user', scope: 'user' },
  ],
});
test('失败保留旧数据及错误，恢复成功的空列表清除旧资源', () => {
  const previous = snapshot();
  const failed = {
    ...snapshot(),
    docker: status(false, 'timeout'),
    containers: [],
    pm2Processes: [],
  };
  const merged = mergeServiceInventory(previous, failed);
  assert.deepEqual(merged.containers, previous.containers);
  assert.equal(merged.docker.error, 'timeout');
  assert.equal(merged.docker.available, true);
  assert.deepEqual(merged.pm2Processes, []);
  const recovered = mergeServiceInventory(merged, { ...snapshot(), containers: [] });
  assert.deepEqual(recovered.containers, []);
  assert.equal(recovered.docker.error, '');
});
test('Systemd 按作用域更新，单侧失败不清空另一侧旧资源', () => {
  const merged = mergeServiceInventory(snapshot(), {
    ...snapshot(),
    systemdUser: status(false, 'timeout'),
    systemUnits: [],
  });
  assert.deepEqual(merged.systemUnits, [{ id: 'user', scope: 'user' }]);
});
test('首次失败和切换主机不复用其他主机数据', () => {
  const next = {
    ...snapshot(),
    target: { id: 'other' },
    containers: [],
    docker: status(false, 'offline'),
  };
  assert.equal(mergeServiceInventory(snapshot(), next), next);
  assert.equal(mergeServiceInventory(null, next), next);
});
