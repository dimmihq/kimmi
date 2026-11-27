import { Laptop, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '@/api/http';
import { useMe } from '@/api/queries';
import { useChangePassword, useEndSession, useSessions, useUpdateMe } from '@/api/settings';
import type { AuthSession } from '@/api/types';
import { ago } from '@/lib/format';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Page,
  SettingRow,
  SettingSection,
  SettingsHeader,
  SettingsListItem,
  Tag,
  toast,
} from '@/ui';
import { failed, fieldError, InlineError, Loaded, SavingInput, SkeletonItems } from './parts';

const EMPTY = { current: '', next: '', confirm: '' };

const MOBILE = /ios|iphone|ipad|android/i;
const device = (session: AuthSession) => `${session.browser} on ${session.os}`;

export function Profile() {
  const me = useMe().data;
  const updateMe = useUpdateMe();
  const sessions = useSessions();
  const endSession = useEndSession();
  const changePassword = useChangePassword();

  const [ending, setEnding] = useState<AuthSession | null>(null);
  const [changing, setChanging] = useState(false);
  const [password, setPassword] = useState(EMPTY);

  const mismatch = password.confirm.length > 0 && password.confirm !== password.next;
  const ready =
    password.current.length > 0 &&
    password.next.length >= 8 &&
    password.next === password.confirm &&
    !changePassword.isPending;
  // A wrong current password belongs under that field; anything else under the new one.
  const failure = changePassword.error;
  const wrongCurrent =
    failure instanceof ApiError && failure.fields.current ? failure.fields.current : null;
  const otherFailure = failure && !wrongCurrent ? fieldError(failure, 'next') : null;

  const openPassword = (open: boolean) => {
    setChanging(open);
    if (!open) {
      setPassword(EMPTY);
      changePassword.reset();
    }
  };

  const edit = (patch: Partial<typeof EMPTY>) => {
    setPassword({ ...password, ...patch });
    if (failure) changePassword.reset();
  };

  const submitPassword = () => {
    if (!ready) return;
    changePassword.mutate(
      { current: password.current, next: password.next },
      {
        onSuccess: () => {
          openPassword(false);
          toast('Password changed');
        },
      },
    );
  };

  // This browser first, then the most recently active.
  const list = [...(sessions.data ?? [])].sort(
    (a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt,
  );

  return (
    <Page>
      <SettingsHeader title="Profile" description="Your name, email and how you sign in." />

      <SettingSection title="Account" description="How you appear to the rest of the team">
        <SettingRow title="Name" description="Shown next to what you do in kimmi." htmlFor="profile-name">
          <Loaded value={me?.user}>
            {(user) => (
              <SavingInput
                id="profile-name"
                field="name"
                value={user.name}
                onSave={(name) => updateMe.mutateAsync({ name: name.trim() })}
                autoComplete="name"
              />
            )}
          </Loaded>
        </SettingRow>
        <SettingRow title="Email" description="Used to sign in." htmlFor="profile-email">
          <Loaded value={me?.user}>
            {(user) => (
              <SavingInput
                id="profile-email"
                type="email"
                field="email"
                value={user.email}
                onSave={(email) => updateMe.mutateAsync({ email: email.trim() })}
                autoComplete="email"
              />
            )}
          </Loaded>
        </SettingRow>
      </SettingSection>

      <SettingSection title="Password" description="The password you sign in to kimmi with">
        <SettingRow title="Password" description="At least 8 characters.">
          <Button onClick={() => setChanging(true)}>Change password</Button>
        </SettingRow>
      </SettingSection>

      <SettingSection title="Sessions" description="Browsers signed in to your account">
        {sessions.isPending ? (
          <SkeletonItems count={2} />
        ) : sessions.isError ? (
          <InlineError error={sessions.error} onRetry={() => void sessions.refetch()} />
        ) : (
          list.map((session) => (
            <SettingsListItem
              key={session.id}
              leading={
                <span className="flex size-7 items-center justify-center rounded-md bg-chip text-fg-muted">
                  {MOBILE.test(session.os) ? (
                    <Smartphone className="size-3.5" />
                  ) : (
                    <Laptop className="size-3.5" />
                  )}
                </span>
              }
              title={device(session)}
              description={`${session.ip} · ${session.current ? 'Active now' : `Last active ${ago(session.lastSeenAt)}`}`}
              actions={
                session.current ? (
                  <Tag tone="brand">This browser</Tag>
                ) : (
                  <Button size="sm" onClick={() => setEnding(session)}>
                    Sign out
                  </Button>
                )
              }
            />
          ))
        )}
      </SettingSection>

      <Dialog
        open={changing}
        onOpenChange={openPassword}
        title="Change password"
        description="Other browsers stay signed in until you sign them out."
        footer={
          <>
            <Button onClick={() => openPassword(false)}>Cancel</Button>
            <Button variant="primary" disabled={!ready} onClick={submitPassword}>
              Change password
            </Button>
          </>
        }
      >
        <Field
          label="Current password"
          hint={wrongCurrent ? <span className="text-danger-fg">{wrongCurrent}</span> : undefined}
        >
          <Input
            type="password"
            autoComplete="current-password"
            aria-invalid={wrongCurrent ? true : undefined}
            value={password.current}
            onChange={(event) => edit({ current: event.target.value })}
          />
        </Field>
        <Field
          label="New password"
          hint={
            otherFailure ? (
              <span className="text-danger-fg">{otherFailure}</span>
            ) : (
              'At least 8 characters.'
            )
          }
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={password.next}
            onChange={(event) => edit({ next: event.target.value })}
          />
        </Field>
        <Field
          label="Confirm new password"
          hint={mismatch ? <span className="text-danger-fg">The passwords do not match.</span> : undefined}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={password.confirm}
            onChange={(event) => edit({ confirm: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitPassword();
            }}
          />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
        title="Sign out this browser"
        description={ending ? `${device(ending)} (${ending.ip}) will need to sign in again.` : ''}
        confirmLabel="Sign out"
        danger
        onConfirm={() => {
          if (!ending) return;
          endSession.mutate(ending.id, { onSuccess: () => toast('Signed out'), onError: failed });
        }}
      />
    </Page>
  );
}
