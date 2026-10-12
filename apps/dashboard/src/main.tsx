import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { isChatWindow } from './chatWindow';
import { hub } from './hub';
import { ChatWindow } from './tabs/ChatWindow';
import './styles.css';
import './styles/live.css';
import './styles/sound.css';
import './styles/onscreen.css';
import './styles/settings.css';
import './styles/chat.css';

// The desktop shell draws the toolbar under the macOS traffic lights; styles.css leaves room for them.
if ('__TAURI_INTERNALS__' in window) document.documentElement.dataset.shell = 'desktop';

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isChatWindow() ? <ChatWindow client={hub} /> : <App client={hub} />}</StrictMode>,
);
