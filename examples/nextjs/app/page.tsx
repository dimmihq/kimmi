import Link from 'next/link';

const features = [
  { title: 'Reminders that sound human', body: 'Polite nudges go out on day 3, 10 and 30, written the way you would write them.' },
  { title: 'Pay in two clicks', body: 'Cards, bank transfer and Apple Pay from the invoice itself. No account needed.' },
  { title: 'Know who is late', body: 'One list of everything overdue, sorted by how much it costs you to wait.' },
];

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <h1>Invoices that get paid on time</h1>
        <p>Paperplane sends, chases and reconciles your invoices so you can get back to the work.</p>
        <div className="actions">
          <Link href="/signup" className="button primary">
            Start a free trial
          </Link>
          <Link href="/pricing" className="button" data-testid="hero-pricing">
            See pricing
          </Link>
        </div>
      </section>
      <section className="features">
        {features.map((feature) => (
          <article key={feature.title} className="card">
            <h2>{feature.title}</h2>
            <p>{feature.body}</p>
          </article>
        ))}
      </section>
    </>
  );
}
