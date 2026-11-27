import { Link } from 'react-router';
import { formatPrice, useProducts } from '../products';

export function HomePage() {
  const products = useProducts();

  return (
    <>
      <section className="hero">
        <h1>Things made to last</h1>
        <p>Small-batch homeware from workshops we have visited ourselves.</p>
      </section>
      {products === null ? (
        <p className="empty">Loading the catalogue…</p>
      ) : (
        <ul className="grid">
          {products.map((product) => (
            <li key={product.id} className="card">
              <Link to={`/products/${product.id}`} className="card-link" data-testid={`product-${product.id}`}>
                <div className="swatch" style={{ background: product.color }} />
                <div className="card-body">
                  <span className="muted">{product.category}</span>
                  <strong>{product.name}</strong>
                  <span>{formatPrice(product.price)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
