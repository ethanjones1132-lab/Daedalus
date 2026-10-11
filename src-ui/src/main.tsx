import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './styles/app.css';
import App from './App';

async function boot() {
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('mock')) {
    const { installDevMocks } = await import('./dev/mock');
    await installDevMocks();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
