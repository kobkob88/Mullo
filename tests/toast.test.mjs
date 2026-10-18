import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toast, hideToastOnScroll, hideToastOnDrag } from '../app/ui/toast.js';

// Just enough of a document for toast.js and dom.js h(), without a browser.
function fakeToast() {
  class Node {
    constructor() { this.children = []; this.attrs = {}; this.dataset = {}; this.className = ''; }
    setAttribute(k, v) { this.attrs[k] = v; }
    append(...kids) { this.children.push(...kids); }
  }
  const classes = new Set();
  const el = Object.assign(new Node(), {
    hidden: true, offsetWidth: 0,
    classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), has: (c) => classes.has(c) },
    replaceChildren(...kids) { this.children = kids; },
  });
  globalThis.Node = Node;
  globalThis.document = {
    getElementById: (id) => (id === 'toast' ? el : null),
    createElement: () => new Node(),
    createTextNode: (text) => Object.assign(new Node(), { text }),
    createDocumentFragment: () => new Node(),
  };
  return el;
}

test('a drag hides the message at once, even right after it appeared (a page too short to scroll)', async () => {
  const el = fakeToast();
  toast('Mullo Pro is now part of your account');
  assert.equal(el.hidden, false);
  assert.ok(el.classList.has('is-in'), 'it slides in');
  hideToastOnScroll();
  assert.ok(!el.classList.has('is-out'), 'a scroll in the first moment may be the app itself going to the top');
  hideToastOnDrag();
  assert.ok(el.classList.has('is-out'), 'a finger moving the page always sends it away');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(el.hidden, true, 'gone once it has slid up');
  delete globalThis.document;
  delete globalThis.Node;
});

test('a new message while one slides away stays up', async () => {
  const el = fakeToast();
  toast('First');
  hideToastOnDrag();
  toast('Second', { error: true });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(el.hidden, false, 'the slide-away of the first must not hide the second');
  assert.ok(el.classList.has('is-error'));
  hideToastOnDrag(); // its own timer must not outlive the fake document
  await new Promise((r) => setTimeout(r, 250));
  delete globalThis.document;
  delete globalThis.Node;
});
