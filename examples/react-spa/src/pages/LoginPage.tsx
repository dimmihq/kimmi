import kimmi from '@kimmi/browser';
import { type FormEvent } from 'react';
import { useNavigate } from 'react-router';

export function LoginPage({ onLogin }: { onLogin: (name: string) => void }) {
  const navigate = useNavigate();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '');
    const name = email.split('@')[0] ?? email;
    kimmi.identify(email, { email, name, plan: 'member' });
    console.info('Signed in as', email);
    onLogin(name);
    navigate('/');
  };

  return (
    <section className="panel narrow">
      <h1>Sign in</h1>
      <form className="form" onSubmit={submit}>
        <label>
          Email
          <input name="email" type="email" required data-testid="login-email" />
        </label>
        <label>
          Password
          <input name="password" type="password" required data-testid="login-password" />
        </label>
        <button type="submit" className="button primary" data-testid="login-submit">
          Sign in
        </button>
      </form>
    </section>
  );
}
