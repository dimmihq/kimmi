import Link from 'next/link';

const plans = [
  { name: 'Solo', price: '£0', detail: 'Up to 5 invoices a month', features: ['Automatic reminders', 'Card payments'] },
  { name: 'Studio', price: '£19', detail: 'Unlimited invoices', features: ['Everything in Solo', 'Bank feeds', '3 team members'] },
  { name: 'Agency', price: '£49', detail: 'For teams that bill a lot', features: ['Everything in Studio', 'Client portal', 'Unlimited members'] },
];

export default function PricingPage() {
  return (
    <>
      <h1>Pricing</h1>
      <p className="muted">Every plan includes a 30-day trial. Cancel whenever you like.</p>
      <div className="plans">
        {plans.map((plan) => (
          <article key={plan.name} className="card plan">
            <h2>{plan.name}</h2>
            <p className="price">
              {plan.price}
              <span className="muted"> / month</span>
            </p>
            <p className="muted">{plan.detail}</p>
            <ul>
              {plan.features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            <Link href={`/signup?plan=${plan.name.toLowerCase()}`} className="button primary">
              Choose {plan.name}
            </Link>
          </article>
        ))}
      </div>
    </>
  );
}
