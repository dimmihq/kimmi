import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useCart } from '../cart';
import { formatPrice } from '../products';

export function CheckoutPage() {
  const { total, count, clear } = useCart();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const card = String(data.get('card') ?? '').replace(/\s/g, '');
    if (card.length < 12) {
      console.warn('Checkout rejected: card number too short');
      setError('That card number looks too short.');
      return;
    }
    console.log('Order placed', { items: count, total });
    clear();
    navigate('/thanks');
  };

  return (
    <section className="panel narrow">
      <h1>Checkout</h1>
      <p className="muted">
        {count} item{count === 1 ? '' : 's'} · {formatPrice(total)}
      </p>
      <form className="form" onSubmit={submit}>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required data-testid="email" />
        </label>
        <label>
          Full name
          <input name="name" autoComplete="name" required data-testid="name" />
        </label>
        <label>
          Address
          <textarea name="address" rows={3} autoComplete="street-address" required data-testid="address" />
        </label>
        <label>
          Card number
          <input
            name="card"
            inputMode="numeric"
            autoComplete="cc-number"
            className="kimmi-mask"
            data-private
            data-testid="card"
            placeholder="1234 5678 9012 3456"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="button primary" data-testid="place-order">
          Place order
        </button>
      </form>
    </section>
  );
}
