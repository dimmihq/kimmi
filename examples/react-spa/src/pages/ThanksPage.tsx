import { Link } from 'react-router';

export function ThanksPage() {
  return (
    <div className="empty">
      <h1>Thank you</h1>
      <p>Your order is on its way. We sent the receipt to your inbox.</p>
      <Link to="/" className="button">
        Keep shopping
      </Link>
    </div>
  );
}
