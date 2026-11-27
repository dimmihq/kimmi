import { useSearchParams } from 'react-router';

export function ResetPage() {
  const [params] = useSearchParams();

  return (
    <section className="panel narrow">
      <h1>Choose a new password</h1>
      <p className="muted">{params.has('token') ? 'Your reset link is valid for 30 minutes.' : 'This reset link is incomplete.'}</p>
      <form className="form" onSubmit={(event) => event.preventDefault()}>
        <label>
          New password
          <input name="password" type="password" autoComplete="new-password" data-testid="new-password" />
        </label>
        <button type="submit" className="button primary">
          Save password
        </button>
      </form>
    </section>
  );
}
