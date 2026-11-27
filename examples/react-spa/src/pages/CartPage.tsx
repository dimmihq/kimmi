import { Link } from 'react-router';
import { useCart } from '../cart';
import { formatPrice } from '../products';

export function CartPage() {
  const { lines, total, remove, setQuantity } = useCart();

  if (lines.length === 0) {
    return (
      <div className="empty">
        <p>Your cart is empty.</p>
        <Link to="/" className="button">
          Browse the shop
        </Link>
      </div>
    );
  }

  return (
    <section className="panel">
      <h1>Your cart</h1>
      <ul className="lines">
        {lines.map(({ product, quantity }) => (
          <li key={product.id} className="line">
            <div className="swatch small" style={{ background: product.color }} />
            <div className="line-name">
              <strong>{product.name}</strong>
              <span className="muted">{formatPrice(product.price)}</span>
            </div>
            <div className="stepper">
              <button type="button" aria-label="One fewer" onClick={() => setQuantity(product.id, quantity - 1)}>
                −
              </button>
              <span>{quantity}</span>
              <button type="button" aria-label="One more" onClick={() => setQuantity(product.id, quantity + 1)}>
                +
              </button>
            </div>
            <button type="button" className="link-button" onClick={() => remove(product.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="summary">
        <span>Total</span>
        <strong>{formatPrice(total)}</strong>
      </div>
      <Link to="/checkout" className="button primary" data-testid="go-checkout">
        Check out
      </Link>
    </section>
  );
}
