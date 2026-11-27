import kimmi from '@kimmi/browser';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { CartProvider } from './cart';
import './styles.css';

kimmi.init({
  key: import.meta.env.VITE_KIMMI_KEY ?? '',
  host: import.meta.env.VITE_KIMMI_HOST ?? 'http://localhost:8700',
  release: 'shop@1.4.0',
  // Fernhill account numbers are personal: scrubbed from console, network and error text on top of the built-in rules.
  scrub: (text) => text.replace(/\bFH-\d{6}\b/g, '[account]'),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <CartProvider>
        <App />
      </CartProvider>
    </BrowserRouter>
  </StrictMode>,
);
