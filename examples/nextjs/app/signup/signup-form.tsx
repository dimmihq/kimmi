'use client';

import kimmi from '@kimmi/browser';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export function SignupForm() {
  const router = useRouter();
  const plan = useSearchParams().get('plan') ?? 'solo';
  const [done, setDone] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '');
    const name = String(data.get('name') ?? '');
    kimmi.identify(email, { email, name, plan });
    console.info('Signed up on plan', plan);
    setDone(true);
    router.push('/');
  };

  if (done) return <p>Welcome aboard. Taking you to your dashboard…</p>;

  return (
    <form className="form" onSubmit={submit}>
      <p className="muted">Plan: {plan}</p>
      <label>
        Name
        <input name="name" required autoComplete="name" />
      </label>
      <label>
        Work email
        <input name="email" type="email" required autoComplete="email" />
      </label>
      <label>
        Password
        <input name="password" type="password" required minLength={8} autoComplete="new-password" />
      </label>
      <button type="submit" className="button primary">
        Create account
      </button>
    </form>
  );
}
