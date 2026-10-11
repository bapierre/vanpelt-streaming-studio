import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Popup } from './Popup';
import { connectHub } from './session';
import './styles.css';

const hub = connectHub();
if (hub) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Popup hub={hub} />
    </StrictMode>,
  );
}
