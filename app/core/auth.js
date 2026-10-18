// Roles and permissions (spec §05): three independent lists per role, never
// one flag doing two jobs.
//   screens - screen IDs the role can reach (screen IDs only, nothing else)
//   private - screens where the role sees raw audio and full transcripts
//             (this app's "money": summaries are shareable, the raw
//             recording of someone's conversation is not)
//   writes  - surfaces the role can write
// Every check fails closed: no session, or an unknown role, can do nothing.

import { TABLES } from './surfaces.js';

export const SCREENS = ['library', 'recording', 'record', 'actions', 'search', 'activity', 'settings'];

export const ROLES = {
  owner: {
    screens: SCREENS,
    private: ['recording', 'search'],
    writes: TABLES,
  },
  // A teammate the owner shares with later: sees summaries and action items,
  // can tick actions off, never hears the audio.
  assistant: {
    screens: ['library', 'recording', 'actions', 'search', 'settings'],
    private: [],
    writes: ['action_items', 'activity'],
  },
  viewer: {
    screens: ['library', 'recording', 'actions', 'search', 'settings'],
    private: [],
    writes: [],
  },
};

let session = null;

export function setSession(next) { session = next; }
export function getSession() { return session; }

// Until Supabase Auth is on, the device has one local owner.
export function localOwnerSession() {
  return { userId: 'local-owner', displayName: 'You', roles: ['owner'], local: true };
}

// Signed in (core/account.js): the same owner of this device, now with an
// account. Signed out: the local owner, as before.
export function accountSession(user) {
  if (!user) return localOwnerSession();
  return { userId: user.id, displayName: user.email ?? 'You', email: user.email ?? null, roles: ['owner'], local: false };
}

function grants(list) {
  if (!session || !Array.isArray(session.roles)) return [];
  return session.roles.flatMap((r) => (Object.hasOwn(ROLES, r) ? ROLES[r][list] : []));
}

export const canReach = (screen) => grants('screens').includes(screen);
export const canSeePrivate = (screen) => grants('private').includes(screen);
export const canWrite = (surface) => grants('writes').includes(surface);

// The first reachable screen in a fixed order - only ever a real screen ID.
export function landingScreen() {
  return SCREENS.find(canReach) ?? null;
}

// Anti-lockout: removing your own last owner role needs an explicit
// confirmation that names the consequence.
export function roleRemovalCheck({ actorId, targetId, targetRoles, role, ownersLeft, confirmed }) {
  const lastOwner = role === 'owner' && targetRoles.includes('owner') && ownersLeft <= 1;
  if (lastOwner && actorId === targetId && !confirmed) {
    return { allowed: false, needs: 'confirm', message: 'You are the last owner. Removing this role locks everyone out of settings and sharing.' };
  }
  if (lastOwner && actorId !== targetId) {
    return { allowed: false, message: 'There must always be at least one owner.' };
  }
  return { allowed: true };
}

export class PermissionError extends Error {
  constructor(what) {
    super(`Not allowed: ${what}`);
    this.name = 'PermissionError';
  }
}
