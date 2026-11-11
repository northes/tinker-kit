// Wails 在已取消的绑定调用上再收到拒绝时，会包装成这个错误并作为未处理拒绝抛出。
const cancelledBindingRejection = 'CancelledRejectionError';

export function isCancelledBindingRejection(reason: unknown) {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'name' in reason &&
    reason.name === cancelledBindingRejection
  );
}
