// A strictly increasing, Postgres-shaped timestamp string with microseconds.
// Used as the stand-in for the server's updated_at trigger (drivers/cas.js)
// and to order activity entries written within the same millisecond.

let lastMicros = 0;

export function nextStamp(nowMs = Date.now()) {
  lastMicros = Math.max(nowMs * 1000, lastMicros + 1);
  const ms = Math.floor(lastMicros / 1000);
  const micro = String(lastMicros % 1000).padStart(3, '0');
  return new Date(ms).toISOString().replace('Z', `${micro}Z`);
}
