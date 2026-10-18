# Contributing to Mullo

Thank you for helping.

## How changes reach Mullo

This repository is a copy published with each release. Pull requests are read but not merged
as they are: a change we take is carried into Mullo's main repository and arrives here with the
next release, with you credited in the pull request. Bug reports are welcome as issues; please
never paste anything from your own notes (they are public).

## Before you open a pull request

1. Run `npm test` and `node scripts/smoke.mjs`. Both must pass.
2. Never include keys, tokens, personal recordings or anyone's real data, in code, tests or
   commit messages. Test data is made up (`example.com` addresses, invented names).

## Code rules

Most of these are checked by `tests/architecture.test.mjs`. Don't work around a failing check:
fix the cause, or explain in the pull request why the rule is wrong for this case.

- **No `onclick=`, `style=` or `innerHTML` anywhere.** Behaviour is a `data-action` handled in
  `app/events.js`; looks are a class in `app/app.css`. Build elements with `app/ui/dom.js h()`;
  text a person typed or a recording produced goes through `userText()`.
- **Only `app/core/db.js` touches storage.** Every table has one funnel file
  (`app/core/surfaces.js`). A new table needs `surfaces.js`, `docs/ops/surface-registry.md` and a
  `sql/` step in the same change.
- **Writes:** pass `expected: row.updated_at` when editing something the person saw. A conflict
  comes back as `{ok: false}`: tell the person and keep their edit. Deletes need an `intent`.
- **A new file in `app/`** goes into `deploy-manifest.json` in the same change.
- **Dates** are local `YYYY-MM-DD` strings (`app/core/dates.js`), never
  `toISOString().slice(0, 10)`.
- **No keys or server addresses in `app/`.** Runtime values come from `config.json`, built from
  the environment. No `.env` files, ever. No AI key ever reaches the web code.
- **The Content Security Policy uses Trusted Types** (`app/_headers`, one policy in `app.js`). A
  new script URL (a worker, an audio worklet) must be added there on purpose.
- **Nothing personal in a URL** (server logs keep URLs): audio and options travel in the body.
- **Problem reports never carry note content**, and the AI never changes anything by itself: it
  suggests, and the person taps.
- **No long dashes** (the em dash) in anything a person reads: use a short dash or a comma.
- **The Privacy Policy and Terms** (`worker/src/legal.mjs`) describe what the code does. A change
  to what they describe changes them in the same pull request.

## The terms for contributions

Mullo is licensed under the GNU Affero General Public License v3 (`LICENSE`, `NOTICE`).
By submitting a contribution (code, docs, tests, images or anything else) you agree that:

1. It is your own work, or you have the right to submit it under these terms.
2. It is licensed to everyone under AGPL-3.0-only, like the rest of Mullo.
3. You also grant the Mullo copyright holder a perpetual, worldwide, royalty-free, irrevocable
   license to use, change, sublicense and distribute your contribution under other terms as
   well, including commercial ones. This is what lets Mullo stay one project with one owner
   while being open source.
4. You keep the copyright in your contribution.

Say so in your pull request ("I agree to the terms in CONTRIBUTING.md"). A pull request
without it can't be taken.
