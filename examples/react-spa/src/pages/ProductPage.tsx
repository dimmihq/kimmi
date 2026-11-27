import kimmi from '@kimmi/browser';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useCart } from '../cart';
import { formatPrice, useProducts } from '../products';

export function ProductPage() {
  const { id } = useParams();
  const products = useProducts();
  const { add } = useCart();
  const [stock, setStock] = useState<string | null>(null);
  const product = products?.find((item) => item.id === id);

  if (products === null) return <p className="empty">Loading…</p>;
  if (!product) return <p className="empty">We could not find that product.</p>;

  const checkStock = async () => {
    setStock('Checking…');
    const response = await fetch(`/api/stock/${product.id}.json`);
    if (!response.ok) {
      console.warn(`Stock lookup failed with ${response.status}`);
      setStock('Stock levels are unavailable right now.');
      return;
    }
    setStock('In stock');
  };

  return (
    <article className="product">
      <div className="swatch large" style={{ background: product.color }} />
      <div className="product-info">
        <Link to="/" className="muted">
          ← Back to the shop
        </Link>
        <h1>{product.name}</h1>
        <p className="price">{formatPrice(product.price)}</p>
        <p>{product.description}</p>
        <div className="actions">
          <button type="button" className="button primary" data-testid="add-to-cart" onClick={() => {
              add(product);
              kimmi.track('add_to_cart', { product: product.id });
            }}
          >
            Add to cart
          </button>
          <button type="button" className="button" data-testid="check-stock" onClick={checkStock}>
            Check store stock
          </button>
          <button type="button" className="button ghost" data-testid="dead-button">
            Compare
          </button>
        </div>
        {stock && <p className="notice">{stock}</p>}
      </div>
    </article>
  );
}
