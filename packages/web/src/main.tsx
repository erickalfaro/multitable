import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted JetBrains Mono. Loads woff2 weights bundled into the dev/prod
// build (no external network fetch). The package declares the font under the
// family name `'JetBrains Mono Variable'`, which globals.css references in
// every monospace font-family chain.
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import './styles/globals.css';
import { installDevLogCapture } from './lib/devLogCapture';

installDevLogCapture();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
