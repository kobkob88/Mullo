// Which Gemini model writes summaries, tasks, Ask answers and drafts (S54, spec
// docs/specs/2026-10-17-models-tiers-admin-design.md). Transcription is not here: it stays
// on DEFAULT_MODEL for everyone. The list lives in D1 `settings` (row `models`) and the owner
// edits it from the Admin card; until then DEFAULT_MODELS. The plan decides what a person may
// use (tiersFor); their pick (D1 `model_picks`) is only a wish. Prices are per 1M tokens
// (ai.google.dev, 2026-10-17), for the cost figures later; they never reach the app.

import { ready } from './usage.mjs';

export const TIERS = ['standard', 'max', 'off'];
export const BADGES = ['none', 'recommended', 'new'];
export const THINKING = ['none', 'minimal', 'low'];

// Owner, 2026-10-17: Pro must stay profitable at the full 1,800 minutes, so the Pro list is the
// two Flash-Lite models; 3.8 Flash (doubles 2027-01-01) is Max. Gemini 4 Argon was dropped the
// same day (owner): 6 s with thinking 'low' at best, 45 s at worst, and ~8x the price.
export const DEFAULT_MODELS = [
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', line: 'Fast and careful. Mullo\'s default.', tier: 'standard', badge: 'recommended', thinking: 'none', isDefault: true, priceIn: 0.25, priceOut: 1.5 },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', line: 'Google\'s newer Flash-Lite.', tier: 'standard', badge: 'new', thinking: 'minimal', isDefault: false, priceIn: 0.3, priceOut: 2.5 },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', line: 'Google\'s most capable Flash: better with long, busy meetings.', tier: 'max', badge: 'none', thinking: 'none', isDefault: false, priceIn: 0.75, priceOut: 3.75 },];

const ID = /^gemini-[a-z0-9][a-z0-9.-]{1,60}$/;
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const price = (v) => Math.min(1000, Math.max(0, Number(v) || 0));

export function cleanModels(input) {
  if (!Array.isArray(input) || !input.length || input.length > 20) throw bad('Send 1 to 20 models.');
  const seen = new Set();
  const out = input.map((m) => {
    const id = String(m?.id ?? '');
    if (!ID.test(id)) throw bad(`"${id}" isn't a Gemini model id.`);
    if (seen.has(id)) throw bad(`${id} is listed twice.`);
    seen.add(id);
    const isDefault = m.isDefault === true;
    return {
      id,
      label: String(m.label ?? '').trim().slice(0, 40) || id,
      line: String(m.line ?? '').trim().slice(0, 120),
      tier: TIERS.includes(m.tier) ? m.tier : (isDefault ? 'standard' : 'off'),
      badge: BADGES.includes(m.badge) ? m.badge : 'none',
      thinking: THINKING.includes(m.thinking) ? m.thinking : 'none',
      isDefault,
      priceIn: price(m.priceIn),
      priceOut: price(m.priceOut),
    };
  });
  const defaults = out.filter((m) => m.isDefault);
  if (defaults.length !== 1 || defaults[0].tier !== 'standard') throw bad('Pick exactly one default, and it must be a Pro model.');
  return out;
}

export async function readModels(env) {
  await ready(env);
  const row = await env.DB.prepare("select value from settings where name = 'models'").first();
  if (!row) return DEFAULT_MODELS;
  try { return cleanModels(JSON.parse(row.value)); } catch { return DEFAULT_MODELS; }
}

export async function saveModels(env, models) {
  const clean = cleanModels(models);
  await ready(env);
  await env.DB.prepare(`insert into settings (name, value, updated_at) values ('models', ?, ?)
    on conflict(name) do update set value = excluded.value, updated_at = excluded.updated_at`)
    .bind(JSON.stringify(clean), Math.floor(Date.now() / 1000)).run();
  return clean;
}

// Which tiers a payer may use. Trial and none: the default only ([]).
export function tiersFor(payer) {
  if (payer?.plan === 'own') return payer.provider === 'gemini' ? ['standard', 'max'] : [];
  if (payer?.plan === 'max') return ['standard', 'max'];
  if (payer?.plan === 'pro' || payer?.plan === 'free') return ['standard'];
  return [];
}

export const defaultModel = (list) => list.find((m) => m.isDefault) ?? DEFAULT_MODELS[0];

export function resolveModel(list, tiers, wanted) {
  const m = wanted ? list.find((x) => x.id === wanted && x.tier !== 'off') : null;
  return m && (m.isDefault || tiers.includes(m.tier)) ? m : defaultModel(list);
}

export async function pickOf(env, userId) {
  if (!userId) return null;
  await ready(env);
  return (await env.DB.prepare('select model from model_picks where user_id = ?').bind(userId).first())?.model ?? null;
}

// Any model people can see may be picked (a Max one too: it's used once the plan allows it).
export async function savePick(env, userId, id, list) {
  if (!list.some((m) => m.id === id && m.tier !== 'off')) throw bad('That model isn\'t available.');
  await ready(env);
  await env.DB.prepare(`insert into model_picks (user_id, model, updated_at) values (?, ?, ?)
    on conflict(user_id) do update set model = excluded.model, updated_at = excluded.updated_at`)
    .bind(userId, id, Math.floor(Date.now() / 1000)).run();
}

export function modelsReport(list, tiers, pick) {
  return {
    models: list.filter((m) => m.tier !== 'off').map(({ id, label, line, tier, badge, isDefault }) => ({
      id, label, line, tier, badge, isDefault, allowed: isDefault || tiers.includes(tier),
    })),
    pick: pick ?? null,
    using: resolveModel(list, tiers, pick).id,
  };
}
