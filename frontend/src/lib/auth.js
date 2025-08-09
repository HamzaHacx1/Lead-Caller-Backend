const TOKEN_KEY = 'ld_token';
export function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
export function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }
export function isAuthed() { return !!getToken(); }
