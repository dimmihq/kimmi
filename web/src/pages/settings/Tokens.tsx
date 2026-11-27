import { KeyRound, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useCreateToken, useRevokeToken, useTokens } from '@/api/settings';
import type { ApiToken } from '@/api/types';
import { day } from '@/lib/format';
import { DOCS_URL } from '@/shell/nav';
import {
  Button,
  CodeBlock,
  ConfirmDialog,
  Dialog,
  Field,
  IconButton,
  Input,
  Menu,
  type Option,
  Page,
  Select,
  SettingSection,
  SettingsEmpty,
  SettingsHeader,
  SettingsListItem,
  toast,
} from '@/ui';
import { failed, fieldError, InlineError, SkeletonItems } from './parts';

type Access = ApiToken['access'];
type Expiry = 'never' | '30' | '90' | '365';

const ACCESS: Option<Access>[] = [
  { value: 'read', label: 'Read only' },
  { value: 'write', label: 'Read and write' },
];

const ACCESS_LABEL: Record<Access, string> = { read: 'Read only', write: 'Read and write' };

const ACCESS_HINT: Record<Access, string> = {
  read: 'Lists and exports recordings. Cannot change or delete anything.',
  write: 'Also deletes recordings and changes project settings.',
};

const EXPIRY: Option<Expiry>[] = [
  { value: 'never', label: 'Never' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

/** "56 minutes ago", spelled out the way the list reads. */
function used(timestamp: number | null) {
  if (timestamp === null) return 'Never used';
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60e3));
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'} ago`;
  if (minutes < 60) return `Used ${plural(minutes, 'minute')}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Used ${plural(hours, 'hour')}`;
  return `Used ${plural(Math.round(hours / 24), 'day')}`;
}

export function Tokens() {
  const tokens = useTokens();
  const createToken = useCreateToken();
  const revokeToken = useRevokeToken();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<Access>('read');
  const [expiry, setExpiry] = useState<Expiry>('never');
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const nameError = createToken.error ? fieldError(createToken.error, 'name') : null;

  const openCreate = (open: boolean) => {
    setCreating(open);
    if (!open) {
      setName('');
      setAccess('read');
      setExpiry('never');
      setSecret(null);
      createToken.reset();
    }
  };

  const create = () => {
    if (name.trim().length === 0 || createToken.isPending) return;
    createToken.mutate(
      {
        name: name.trim(),
        access,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
      },
      { onSuccess: (result) => setSecret(result.secret) },
    );
  };

  return (
    <Page>
      <SettingsHeader
        title="API tokens"
        description="Tokens let scripts and other tools use this instance through the API."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            New token
          </Button>
        }
      />

      <SettingSection title="Your tokens" description="Each token acts with your access">
        {tokens.isPending ? (
          <SkeletonItems count={2} />
        ) : tokens.isError ? (
          <InlineError error={tokens.error} onRetry={() => void tokens.refetch()} />
        ) : tokens.data.length === 0 ? (
          <SettingsEmpty
            title="No tokens"
            description="Create a token to call the API from a script."
          />
        ) : (
          tokens.data.map((token) => (
            <SettingsListItem
              key={token.id}
              leading={
                <span className="flex size-7 items-center justify-center rounded-md bg-chip text-fg-muted">
                  <KeyRound className="size-3.5" />
                </span>
              }
              title={token.name}
              description={
                <>
                  <span className="font-mono text-mono">{token.prefix}••••••••</span>
                  {' · '}
                  {ACCESS_LABEL[token.access]}
                  {' · '}
                  {token.expiresAt === null ? 'Never expires' : `Expires ${day(token.expiresAt)}`}
                </>
              }
              meta={`Created ${day(token.createdAt)} · ${used(token.lastUsedAt)}`}
              actions={
                <Menu
                  align="end"
                  trigger={<IconButton icon={MoreHorizontal} label="Token actions" />}
                  actions={[
                    {
                      id: 'revoke',
                      label: 'Revoke',
                      icon: Trash2,
                      tone: 'danger',
                      onSelect: () => setRevoking(token),
                    },
                  ]}
                />
              }
            />
          ))
        )}
      </SettingSection>

      <p className="mt-3 text-meta text-fg-meta">
        Send a token as a bearer header. See the{' '}
        <a
          href={`${DOCS_URL}/api`}
          target="_blank"
          rel="noreferrer"
          className="text-fg-secondary underline underline-offset-2 hover:text-fg"
        >
          API reference
        </a>
        .
      </p>

      <Dialog
        open={creating}
        onOpenChange={openCreate}
        title={secret ? 'Token created' : 'New token'}
        description={
          secret
            ? 'Copy the token now. It is not shown again.'
            : 'A token is shown once, right after you create it.'
        }
        footer={
          secret ? (
            <Button variant="primary" onClick={() => openCreate(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => openCreate(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={name.trim().length === 0 || createToken.isPending}
                onClick={create}
              >
                Create token
              </Button>
            </>
          )
        }
      >
        {secret ? (
          <>
            <CodeBlock code={secret} label={name.trim()} />
            <p className="text-hint text-warning-fg">
              Store it somewhere safe. Anyone holding it can use the API as you.
            </p>
          </>
        ) : (
          <>
            <Field
              label="Name"
              hint={
                nameError ? (
                  <span className="text-danger-fg">{nameError}</span>
                ) : (
                  'Say what uses it, so you know what breaks when you revoke it.'
                )
              }
            >
              <Input
                placeholder="CI export job"
                value={name}
                aria-invalid={nameError ? true : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  if (createToken.isError) createToken.reset();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') create();
                }}
              />
            </Field>
            <Field label="Access" hint={ACCESS_HINT[access]}>
              <Select block label="Access" value={access} onChange={setAccess} options={ACCESS} />
            </Field>
            <Field label="Expires">
              <Select block label="Expires" value={expiry} onChange={setExpiry} options={EXPIRY} />
            </Field>
          </>
        )}
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={revoking ? `Revoke ${revoking.name}` : 'Revoke token'}
        description="Anything using this token stops working right away. This cannot be undone."
        confirmLabel="Revoke"
        danger
        onConfirm={() => {
          if (!revoking) return;
          revokeToken.mutate(revoking.id, {
            onSuccess: () => toast('Token revoked'),
            onError: failed,
          });
        }}
      />
    </Page>
  );
}
