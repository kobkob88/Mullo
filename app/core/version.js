// Getting a deploy onto devices (spec §10). version.txt is published next to
// the app; clients poll it on a timer and on focus and reload when it is
// higher. tests/architecture.test.mjs fails when this number and version.txt
// drift; scripts/bump-version.mjs (run by `npm run deploy`) raises both.

export const APP_VERSION = 96;

// Never reload offline (it reloads into nothing) and never while the person
// is in the middle of something (a recording in progress).
export function shouldReload({ remote, local = APP_VERSION, online, busy }) {
  return Number.isFinite(remote) && remote > local && online === true && !busy;
}

export function createVersionWatch({ fetchVersion, isOnline, isBusy, beforeReload, reload, intervalMs = 5 * 60_000 }) {
  let timer = null;
  let checking = false;

  async function check() {
    if (checking) return false;
    checking = true;
    try {
      const remote = await fetchVersion();
      if (!shouldReload({ remote, online: isOnline(), busy: isBusy() })) return false;
      beforeReload(); // keep half-typed input across the reload
      reload();
      return true;
    } catch {
      return false; // a failed probe is not news
    } finally {
      checking = false;
    }
  }

  return {
    check,
    start() {
      if (!timer) timer = setInterval(check, intervalMs);
      return check();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

export async function fetchPublishedVersion() {
  const res = await fetch('version.txt', { cache: 'no-store' });
  if (!res.ok) throw new Error(`version.txt ${res.status}`);
  return Number.parseInt((await res.text()).trim(), 10);
}
