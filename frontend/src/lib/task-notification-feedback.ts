import { Window } from '@wailsio/runtime';
import {
  IsAvailable,
  RequestAuthorization,
  Send,
} from '../../bindings/tinkerkit/tasknotificationservice';

let authorized: boolean | null = null;

export function showTaskNotificationPermissionDialog() {
  window.dispatchEvent(new Event('tinkerkit:task-notification-permission'));
}

export function primeSystemNotificationAuthorization(mode: string | undefined) {
  const resolved = mode ?? 'unfocused';
  if (resolved === 'off' || authorized !== null) return;
  void IsAvailable()
    .then(async (available) => {
      if (authorized !== null) return;
      if (!available) {
        authorized = false;
        showTaskNotificationPermissionDialog();
        return;
      }
      authorized = await RequestAuthorization();
      if (!authorized) showTaskNotificationPermissionDialog();
    })
    .catch(() => {
      authorized = false;
      showTaskNotificationPermissionDialog();
    });
}

export function sendSystemNotification(input: {
  mode?: string;
  id: string;
  title: string;
  body: string;
}) {
  void deliverSystemNotification(input).catch(() => showTaskNotificationPermissionDialog());
}

async function deliverSystemNotification(input: {
  mode?: string;
  id: string;
  title: string;
  body: string;
}) {
  const mode = input.mode ?? 'unfocused';
  if (mode === 'off') return;
  if (mode === 'unfocused' && (await Window.IsFocused())) return;
  if (!(await IsAvailable())) {
    authorized = false;
    showTaskNotificationPermissionDialog();
    return;
  }
  if (authorized !== true) {
    authorized = await RequestAuthorization();
    if (!authorized) {
      showTaskNotificationPermissionDialog();
      return;
    }
  }
  await Send(input.id, input.title, input.body);
}
