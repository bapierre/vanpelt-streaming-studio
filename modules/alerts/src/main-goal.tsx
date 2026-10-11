import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GoalBar } from './GoalBar';
import { connectHub } from './session';
import './styles.css';

const hub = connectHub();
if (hub) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <GoalBar hub={hub} goalId={new URLSearchParams(location.search).get('goal')} />
    </StrictMode>,
  );
}
