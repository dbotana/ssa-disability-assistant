// Local persistence. Answers live in localStorage so a dropped session can be
// resumed; the API key lives in sessionStorage and is never written beside the
// answers. Nothing here ever leaves the device.

const STATE_KEY = 'ssa-prep.state.v2';
// Written before the form question existed. Still read, so an unfinished
// session survives the upgrade: the engine sees it has no `schema` and
// rebuilds its place as a Starter Kit session.
const LEGACY_STATE_KEYS = ['ssa-prep.state.v1'];
const KEY_KEY = 'ssa-prep.openai-key';

export function saveState(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ savedAt: Date.now(), state }));
    for (const key of LEGACY_STATE_KEYS) localStorage.removeItem(key);
    return true;
  } catch {
    return false; // private mode or quota — the interview continues in memory
  }
}

export function loadState() {
  for (const key of [STATE_KEY, ...LEGACY_STATE_KEYS]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed?.state?.cursor) return parsed;
    } catch {
      /* unreadable — try the next one */
    }
  }
  return null;
}

export function clearState() {
  for (const key of [STATE_KEY, ...LEGACY_STATE_KEYS]) {
    try { localStorage.removeItem(key); } catch { /* nothing to do */ }
  }
}

export function hasSavedSession() {
  return loadState() !== null;
}

export function getApiKey() {
  try { return sessionStorage.getItem(KEY_KEY) || ''; } catch { return ''; }
}

export function setApiKey(key) {
  try { sessionStorage.setItem(KEY_KEY, key.trim()); } catch { /* memory-only */ }
}

export function clearApiKey() {
  try { sessionStorage.removeItem(KEY_KEY); } catch { /* nothing to do */ }
}
