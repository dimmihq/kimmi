import { useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router';
import { useCart } from './cart';
import { CartPage } from './pages/CartPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { PrivacyLabPage } from './pages/PrivacyLabPage';
import { ProductPage } from './pages/ProductPage';
import { ResetPage } from './pages/ResetPage';
import { ThanksPage } from './pages/ThanksPage';

export function App() {
  const { count } = useCart();
  const [user, setUser] = useState<string | null>(null);

  return (
    <div className="shell">
      <header className="header">
        <Link to="/" className="brand">
          Fernhill Goods
        </Link>
        <nav className="nav">
          <NavLink to="/" end>
            Shop
          </NavLink>
          <NavLink to="/login">{user ? `Hi, ${user}` : 'Sign in'}</NavLink>
          <NavLink to="/cart" data-testid="cart-link">
            Cart <span className="badge">{count}</span>
          </NavLink>
        </nav>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/products/:id" element={<ProductPage />} />
          <Route path="/cart" element={<CartPage />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/login" element={<LoginPage onLogin={setUser} />} />
          <Route path="/thanks" element={<ThanksPage />} />
          <Route path="/reset" element={<ResetPage />} />
          <Route path="/privacy-lab" element={<PrivacyLabPage />} />
          <Route path="*" element={<p className="empty">That page does not exist.</p>} />
        </Routes>
      </main>
      <footer className="footer">
        <span>Free delivery over £75 · Returns within 30 days</span>
        <button
          type="button"
          className="link-button"
          data-testid="trigger-error"
          onClick={() => {
            throw new Error('Gift card balance service is unavailable');
          }}
        >
          Trigger an error
        </button>
      </footer>
    </div>
  );
}
