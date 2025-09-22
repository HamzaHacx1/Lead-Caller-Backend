import { api } from './api';

export function callNow(payload) {
  return api('/call-now', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
}
