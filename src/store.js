// Local persistence. Answers live in localStorage so a dropped session can be
// resumed; the API key lives in sessionStorage and is never written beside the
// answers. Nothing here ever leaves the device.

const STATE_KEY = 'ssa-prep.state.v1';
const KEY_KEY = 'ssa-prep.openai-key';

export function saveState(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ savedAt: Date.now(), state }));
    return true;
  } catch {
    return false; // private mode or quota — the interview continues in memory
  }
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.state?.cursor) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearState() {
  try { localStorage.removeItem(STATE_KEY); } catch { /* nothing to do */ }
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
