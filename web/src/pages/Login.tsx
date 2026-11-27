import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useLogin } from '@/api/app';
import { useAuthStatus } from '@/api/queries';
import { AuthHeading, AuthLayout, PasswordInput } from '@/shell/auth';
import { FormError, fieldHint, formErrors } from '@/shell/states';
import { Button, Field, Input } from '@/ui';

export function Login() {
  const location = useLocation();
  const status = useAuthStatus();
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { fields, message } = formErrors(login.error);

  // A fresh install has nobody to log in as: the first visit creates the owner.
  if (status.data?.hasUsers === false) {
    return <Navigate to="/signup" replace state={location.state} />;
  }

  return (
    <AuthLayout>
      <form
        className="w-full max-w-[340px] animate-swap-in"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate({ email: email.trim(), password });
        }}
      >
        <AuthHeading title="Log in to kimmi" description="Enter your credentials to open the dashboard." />
        <div className="flex flex-col gap-4">
          <Field label="Email" hint={fieldHint(fields.email)}>
            <Input
              type="email"
              required
              placeholder="name@company.com"
              autoComplete="email"
              className="h-9"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Password" hint={fieldHint(fields.password)}>
            <PasswordInput
              required
              placeholder="Enter your password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <div className="mt-2 flex flex-col gap-2">
            <FormError message={message} />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              disabled={login.isPending}
            >
              Log in
            </Button>
          </div>
          {status.data?.signups === 'open' ? (
            <p className="text-center text-meta text-fg-meta">
              New here?{' '}
              <Link to="/signup" state={location.state} className="text-fg hover:underline">
                Create an account
              </Link>
            </p>
          ) : null}
        </div>
      </form>
    </AuthLayout>
  );
}
