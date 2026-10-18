// DOM building without innerHTML. Text always goes in as text nodes, so
// transcripts and imported titles (untrusted) can never become markup.
// Inline handlers and style attributes are refused outright: they would force
// 'unsafe-inline' into the CSP. Behaviour goes on data-action (see events.js),
// looks go in app.css.

const FORBIDDEN_ATTR = /^(?:on[a-z]+|style)$/i;

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (FORBIDDEN_ATTR.test(key)) throw new Error(`h(): "${key}" is not allowed - use a class or data-action`);
    if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'data') for (const [k, v] of Object.entries(value)) { if (v != null) el.dataset[k] = String(v); }
    else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'selected') el[key] = Boolean(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  appendAll(el, children);
  return el;
}

export function appendAll(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// The direction of a piece of text from its first strong letter, for laying
// out a whole row (checkbox, text, buttons) the way the text reads.
export function textDir(text) {
  for (const ch of String(text ?? '')) {
    if (/[֐-ࣿיִ-﷿ﹰ-﻿]/.test(ch)) return 'rtl';
    if (/\p{L}/u.test(ch)) return 'ltr';
  }
  return 'ltr';
}

// User or imported text: direction follows the text (Hebrew right-to-left).
export function userText(tag, text, attrs = {}) {
  return h(tag, { dir: 'auto', ...attrs }, text ?? '');
}

export function frag(...children) {
  return appendAll(document.createDocumentFragment(), children);
}

export function options(list, selected) {
  return list.map(([value, label]) => h('option', { value, selected: value === selected }, label));
}
