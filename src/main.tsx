import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import { config } from '@fortawesome/fontawesome-svg-core';
import '@fortawesome/fontawesome-svg-core/styles.css';
import App from './App';
import { theme } from './theme';
import './styles.css';

// Vite injects the icon CSS itself, so stop Font Awesome adding a duplicate
// <style> tag at runtime (which causes a flash of oversized icons).
config.autoAddCss = false;

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

// Without the preload bridge every call would throw inside a render and leave a
// blank window, so say what is wrong instead of failing silently.
if (typeof window.lanScout === 'undefined') {
  container.innerHTML = `
    <div class="empty">
      <div class="empty__icon">!</div>
      <h3>Preload bridge unavailable</h3>
      <p>
        The renderer could not reach the main process, so no scanning is possible.
        Rebuild with <code>npm run build</code> and relaunch.
      </p>
    </div>`;
} else {
  createRoot(container).render(
    <StrictMode>
      <ThemeProvider theme={theme}>
        <App />
      </ThemeProvider>
    </StrictMode>,
  );
}
