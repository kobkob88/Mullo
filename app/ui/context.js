// What every screen may ask of the shell. app.js fills it in at boot;
// screens import it instead of importing app.js.

export const ctx = {
  config: {},
  refresh: () => {},
  go: (hash) => { location.hash = hash; },
  toast: (message) => console.info(message),
};

export function setContext(values) {
  Object.assign(ctx, values);
}
