/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// IDE API client — the one door to ide/api.php
// ============================================
//
// The token can arrive two ways:
//   1. the studio opens this page in an iframe and answers our handshake with
//      a postMessage { type: 'ide:auth', token } — the parent knows the token
//      from its own Config, so the user never pastes it here;
//   2. nobody answers (standalone tab): we show the lock screen and the user
//      pastes it once. It is kept in localStorage under ide.token.v1, next to
//      where the main app keeps its own settings.
//
// Every request carries X-Router-Token (and X-Sandbox-Token too, because the
// main API accepts either and a rotated token can be current in one and stale
// in the other).

const TOKEN_KEY = 'ide.token.v1';
const SAME_ORIGIN = window.location.origin;

let token = null;
try { token = localStorage.getItem(TOKEN_KEY) || null; } catch { /* private mode */ }

const authWaiters = [];

function setToken(t) {
  token = (t || '').trim() || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
  } catch { /* private mode: keep it for this page only */ }
}

/** Promise that resolves when some caller answers the auth handshake. */
function waitForAuth() {
  return new Promise((resolve) => authWaiters.push(resolve));
}

/** Ask the parent window (if any) for the token, once, on boot. */
function handshake() {
  if (window.parent && window.parent !== window) {
    try {
      window.parent.postMessage({ type: 'ide:hello' }, SAME_ORIGIN);
    } catch { /* cross-origin parent: never ours */ }
  }
}

window.addEventListener('message', (e) => {
  if (e.origin !== SAME_ORIGIN) return;
  const msg = e.data;
  if (!msg || msg.type !== 'ide:auth') return;
  setToken(msg.token);
  while (authWaiters.length) authWaiters.shift()(true);
});

export class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail || '';
  }
}

async function call(path, opts = {}) {
  const headers = {};
  if (token) {
    headers['X-Router-Token'] = token;
    headers['X-Sandbox-Token'] = token;
  }
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    // Either nothing was ever sent or it is wrong. Surface a typed error; the
    // app shows the lock screen and waits for a better token.
    const err = new ApiError(401, 'locked');
    throw err;
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body (e.g. 500 page) */ }
  if (!res.ok) {
    throw new ApiError(res.status, (json && json.error) || `HTTP ${res.status}`,
      (json && json.detail) || '');
  }
  return json;
}

// Relative to this document (ide/index.php), so the IDE works at any mount
// point — /ide/ here, /router/ide/ under an Apache subpath.
const API = 'api.php';
const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const ideApi = {
  ApiError,
  waitForAuth,
  handshake,
  getToken: () => token,
  setToken,

  info: () => call(`${API}${qs({ action: 'info' })}`),
  list: (path) => call(`${API}${qs({ action: 'list', path })}`),
  read: (path) => call(`${API}${qs({ action: 'read', path })}`),
  search: (q, { path = '', caseSensitive = false, regex = false } = {}) =>
    call(`${API}${qs({ action: 'search', q, path, case: caseSensitive ? 1 : 0, regex: regex ? 1 : 0 })}`),
  write: (path, content, encoding = 'text') =>
    call(`${API}`, { method: 'POST', body: JSON.stringify({ action: 'write', path, content, encoding }) }),
  create: (path, type = 'file', content = '') =>
    call(`${API}`, { method: 'POST', body: JSON.stringify({ action: 'create', path, type, content }) }),
  rename: (from, to) =>
    call(`${API}`, { method: 'POST', body: JSON.stringify({ action: 'rename', from, to }) }),
  del: (path) =>
    call(`${API}`, { method: 'POST', body: JSON.stringify({ action: 'delete', path }) }),
};
