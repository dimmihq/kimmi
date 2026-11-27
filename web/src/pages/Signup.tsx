import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useSignup } from '@/api/app';
import { useAuthStatus } from '@/api/queries';
import { AuthHeading, AuthLayout, PasswordInput } from '@/shell/auth';
import { ErrorNote, FormError, fieldHint, formErrors } from '@/shell/states';
import { Button, Field, Input, LinkButton } from '@/ui';

export function Signup() {
  const location = useLocation();
  const status = useAuthStatus();
  const signup = useSignup();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { fields, message } = formErrors(signup.error);

  if (status.isError) {
    return (
      <AuthLayout>
        <ErrorNote error={status.error} onRetry={() => void status.refetch()} />
      </AuthLayout>
    );
  }
  if (status.isPending) return <AuthLayout>{null}</AuthLayout>;

  const first = !status.data.hasUsers;
  if (!first && status.data.signups === 'closed') {
    return (
      <AuthLayout>
        <div className="w-full max-w-[340px] animate-swap-in">
          <AuthHeading
            title="Sign up is invite only"
            description="Ask someone on your team for an invite link. It signs you up in one step."
          />
          <LinkButton to="/login" state={location.state} size="lg" className="w-full">
            Log in instead
          </LinkButton>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <form
        className="w-full max-w-[340px] animate-swap-in"
        onSubmit={(event) => {
          event.preventDefault();
          signup.mutate({ name: name.trim(), email: email.trim(), password });
        }}
      >
        <AuthHeading
          title={first ? 'Set up kimmi' : 'Create your account'}
          description={
            first
              ? 'Nobody has signed up yet. This account owns the instance.'
              : 'Your own workspace for recording sites and apps.'
          }
        />
        <div className="flex flex-col gap-4">
          <Field label="Name" hint={fieldHint(fields.name)}>
            <Input
              required
              autoFocus
              placeholder="Ada Lovelace"
              autoComplete="name"
              className="h-9"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
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
              placeholder="Choose a password"
              autoComplete="new-password"
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
              disabled={signup.isPending}
            >
              Create account
            </Button>
          </div>
          {first ? null : (
            <p className="text-center text-meta text-fg-meta">
              Already have an account?{' '}
              <Link to="/login" state={location.state} className="text-fg hover:underline">
                Log in
              </Link>
            </p>
          )}
        </div>
      </form>
    </AuthLayout>
  );
}
