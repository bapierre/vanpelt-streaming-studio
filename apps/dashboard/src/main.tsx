import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { hub } from './hub';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={hub} />
  </StrictMode>,
);
