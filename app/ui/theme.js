// Appearance: 'system' follows the phone; 'dark' / 'light' pin it.
// app.css reads <html data-theme>; the installed shell keeps its dark theme colour.

export function applyTheme(appearance) {
  const root = document.documentElement;
  if (appearance === 'dark' || appearance === 'light') root.dataset.theme = appearance;
  else delete root.dataset.theme;
}
