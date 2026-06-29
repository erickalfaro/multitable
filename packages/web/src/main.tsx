import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted fonts. Both packages declare variable woff2 weights bundled
// into the dev/prod build (no external network fetch). Inter is the Zen
// humanist sans used for UI / prose (body default); JetBrains Mono backs
// code / terminal / composer (opt-in via .mt-mono / `<code>` / `<pre>` /
// the `--font-mono` token).
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
// Lora — the elegant transitional serif used only for display / empty-state
// hero microcopy (lowercase, one italic word). UI/prose stays Inter.
import '@fontsource-variable/lora';
import App from './App';
import './styles/globals.css';
import { installDevLogCapture } from './lib/devLogCapture';

installDevLogCapture();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
