import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { isChatWindow } from './chatWindow';
import { hub } from './hub';
import { loadPrefs } from './prefs';
import { applyAppearance } from './theme';
import { ChatWindow } from './tabs/ChatWindow';
import './styles.css';
import './styles/live.css';
import './styles/sound.css';
import './styles/onscreen.css';
import './styles/settings.css';
import './styles/chat.css';

// The desktop shell draws the toolbar under the macOS traffic lights; styles.css leaves room for them.
if ('__TAURI_INTERNALS__' in window) document.documentElement.dataset.shell = 'desktop';
// Set before the first paint so the window never flashes the other theme.
applyAppearance(loadPrefs().appearance);

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isChatWindow() ? <ChatWindow client={hub} /> : <App client={hub} />}</StrictMode>,
);
