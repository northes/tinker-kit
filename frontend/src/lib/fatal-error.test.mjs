import assert from 'node:assert/strict';
import test from 'node:test';
import { isCancelledBindingRejection } from './fatal-error.ts';

test('已取消的 SSH 绑定调用迟到失败不能算作页面崩溃', () => {
  const rejection = new Error('Unhandled rejection in cancelled promise. Reason: connect failed');
  rejection.name = 'CancelledRejectionError';
  assert.equal(isCancelledBindingRejection(rejection), true);
  assert.equal(isCancelledBindingRejection(new Error('connect failed')), false);
  assert.equal(isCancelledBindingRejection('connect failed'), false);
  assert.equal(isCancelledBindingRejection(null), false);
});
