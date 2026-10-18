// Runtime configuration. No live IDs, keys or URLs in source (spec §06):
// real values come from config.json, written at deploy time by
// scripts/build.mjs from environment variables, and gitignored.
// Without it the app runs fully on the device.

const DEFAULTS = {
  backend: 'local',        // 'local' | 'supabase'
  supabaseUrl: null,
  supabaseAnonKey: null,   // publishable key only - RLS is the control
  // MCP bridge + AI engine (bridge/server.mjs). null = off;
  // '' = same origin (the dev server forwards /api to the bridge).
  bridgeUrl: null,
  // Android app only: 'pro' when a Mullo Pro key is saved (then aiKey is that key);
  // 'account' when bridgeUrl is Mullo's server and no key is saved: AI follows the
  // signed-in account's plan (core/ai-plan.js). null = a dev bridge, no plan.
  aiPlan: null,
  aiKey: null,
  // Android app only: the person's own AI key as Mullo's server sealed it (core/own-ai.js).
  aiOwnKey: null,
  // true when supabaseUrl is the person's own project, not Mullo's (Android, or a browser's
  // choice: core/own-server.js).
  ownServer: false,
  // Then Mullo's own account server: they sign in there too, for the AI and the Terms (S25).
  // Public values, like supabaseUrl.
  mulloSupabaseUrl: null,
  mulloSupabaseAnonKey: null,
};

export async function loadConfig() {
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (res.ok) return { ...DEFAULTS, ...(await res.json()) };
  } catch { /* offline or absent: defaults */ }
  return { ...DEFAULTS };
}

export const bridgeOn = (config) => typeof config?.bridgeUrl === 'string';
