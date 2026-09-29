export function showTaskNotificationPermissionDialog() {
  window.dispatchEvent(new Event('tinkerkit:task-notification-permission'));
}
