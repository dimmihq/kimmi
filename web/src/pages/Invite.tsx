import { useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { isNotFound, useAcceptInvitation, useInvitation } from '@/api/app';
import { AuthHeading, AuthLayout, PasswordInput } from '@/shell/auth';
import { ErrorNote, FormError, fieldHint, formErrors, Skeleton } from '@/shell/states';
import { Button, Field, Input, LinkButton } from '@/ui';

export function Invite() {
  const { token = '' } = useParams();
  const invitation = useInvitation(token);
  const accept = useAcceptInvitation();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const { fields, message } = formErrors(accept.error);

  if (accept.isSuccess) return <Navigate to="/projects" replace />;

  if (invitation.isError) {
    return (
      <AuthLayout>
        {isNotFound(invitation.error) ? (
          <div className="w-full max-w-[340px] animate-swap-in">
            <AuthHeading
              title="This invite no longer works"
              description="It was used, withdrawn or has expired. Ask whoever invited you for a new link."
            />
            <LinkButton to="/login" size="lg" className="w-full">
              Log in
            </LinkButton>
          </div>
        ) : (
          <ErrorNote error={invitation.error} onRetry={() => void invitation.refetch()} />
        )}
      </AuthLayout>
    );
  }

  const details = invitation.data;

  return (
    <AuthLayout>
      <form
        className="w-full max-w-[340px] animate-swap-in"
        onSubmit={(event) => {
          event.preventDefault();
          accept.mutate({ token, name: name.trim(), password });
        }}
      >
        <AuthHeading
          title={details ? `Join ${details.orgName}` : 'Join your team'}
          description={
            details ? (
              <>
                You were invited as <span className="text-fg">{details.email}</span> with the{' '}
                {details.role} role.
              </>
            ) : (
              <Skeleton className="mt-1.5 h-3 w-56" />
            )
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
            <FormError message={message ?? (fields.token ? fields.token : null)} />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              disabled={!details || accept.isPending}
            >
              Accept invite
            </Button>
          </div>
        </div>
      </form>
    </AuthLayout>
  );
}
