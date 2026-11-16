// Explicit browser allowlist entries. This does not authorize automatic control.
export function validWebOrigin(value) {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.search || url.hash || !url.hostname || url.hostname.includes('*')) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (['127.0.0.1', '[::1]', 'localhost', 'local.lt.com', 'lt.com'].includes(url.hostname) || url.hostname.endsWith('.localhost'));
  } catch { return false; }
}
export function validAutoTrustOrigin(value) {
  return validWebOrigin(value) && /^http:\/\/127\.0\.0\.1:\d+$/.test(value);
}
