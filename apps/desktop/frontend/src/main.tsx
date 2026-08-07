import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@netlink/ui/tokens.css';
import '@netlink/ui/base.css';
import './components/mark.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('NetLink could not find its root element.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
