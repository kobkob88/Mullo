// Privacy Policy and Terms accepted (S23, 2026-10-11; worker/src/acceptance.mjs). Mullo's server
// keeps which version each account accepted; /api/me says the current one and the accepted one,
// and the app's last answer (ai-plan.js, `legal`) is what this reads.
//
// The sign-in page ticks both before "Email me a code" / "Continue with Google"; the tick is
// told to the server once the sign-in lands (app.js, on 'account'). Mullo's own server only.

let tickedAtSignIn = false;

// The sign-in about to happen was ticked (settings.js), or it failed (`false`).
export function noteTicked(on = true) { tickedAtSignIn = on; }

// Once, right after the sign-in it was ticked for.
export function takeTicked() {
  const ticked = tickedAtSignIn;
  tickedAtSignIn = false;
  return ticked;
}

// The plan's last answer says a newer version than the one accepted (or none accepted):
// → { current, accepted, changes }, else null. No answer yet = nothing to ask.
export function legalPending(plan) {
  const legal = plan?.legal;
  return legal?.current && legal.accepted !== legal.current ? legal : null;
}
