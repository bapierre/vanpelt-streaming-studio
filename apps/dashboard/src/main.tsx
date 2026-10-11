import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { hub } from './hub';
import './styles.css';

// The desktop shell draws the toolbar under the macOS traffic lights; styles.css leaves room for them.
if ('__TAURI_INTERNALS__' in window) document.documentElement.dataset.shell = 'desktop';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={hub} />
  </StrictMode>,
);
