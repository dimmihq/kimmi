import { Link2, Mail, MoreHorizontal, Plus, Trash2, UserCog } from 'lucide-react';
import { useState } from 'react';
import { useMe } from '@/api/queries';
import {
  canManage,
  useChangeMemberRole,
  useCreateInvitation,
  useInvitations,
  useMembers,
  useRemoveMember,
  useRevokeInvitation,
} from '@/api/settings';
import type { Invitation, Role, User } from '@/api/types';
import { day } from '@/lib/format';
import {
  Avatar,
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
  Tag,
  toast,
} from '@/ui';
import { failed, fieldError, InlineError, SkeletonItems } from './parts';

type AssignableRole = Exclude<Role, 'owner'>;

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

const ROLES: Option<AssignableRole>[] = (['admin', 'member', 'viewer'] as const).map((value) => ({
  value,
  label: ROLE_LABEL[value],
}));

const ROLE_HINT: Record<AssignableRole, string> = {
  admin: 'Manages members, projects and instance settings.',
  member: 'Watches recordings and changes project settings.',
  viewer: 'Watches recordings. Cannot change anything.',
};

const DAY = 86400e3;

function expires(timestamp: number) {
  const days = Math.ceil((timestamp - Date.now()) / DAY);
  if (days <= 0) return 'Expired';
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

function copyLink(link: string) {
  void navigator.clipboard?.writeText(link);
  toast('Invite link copied');
}

export function Team() {
  const me = useMe().data?.user;
  const manage = canManage(me?.role);
  const members = useMembers();
  const invitations = useInvitations();
  const createInvitation = useCreateInvitation();
  const changeRole = useChangeMemberRole();
  const removeMember = useRemoveMember();
  const revokeInvitation = useRevokeInvitation();

  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AssignableRole>('member');
  const [link, setLink] = useState<string | null>(null);

  const [editing, setEditing] = useState<User | null>(null);
  const [nextRole, setNextRole] = useState<AssignableRole>('member');
  const [removing, setRemoving] = useState<User | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);

  const validEmail = /^\S+@\S+\.\S+$/.test(email.trim());
  const inviteError = createInvitation.error ? fieldError(createInvitation.error, 'email') : null;

  const openInvite = (open: boolean) => {
    setInviting(open);
    if (!open) {
      setEmail('');
      setRole('member');
      setLink(null);
      createInvitation.reset();
    }
  };

  const invite = () => {
    if (!validEmail || createInvitation.isPending) return;
    createInvitation.mutate(
      { email: email.trim(), role },
      { onSuccess: (result) => setLink(result.link) },
    );
  };

  return (
    <Page>
      <SettingsHeader
        title="Members"
        description="Who can sign in to this kimmi instance and what they can do."
        actions={
          manage ? (
            <Button variant="primary" icon={Plus} onClick={() => setInviting(true)}>
              Invite
            </Button>
          ) : null
        }
      />

      <SettingSection title="Members" description="People with access to this kimmi instance">
        {members.isPending ? (
          <SkeletonItems round />
        ) : members.isError ? (
          <InlineError error={members.error} onRetry={() => void members.refetch()} />
        ) : (
          members.data.map((member) => {
            const you = member.id === me?.id;
            const locked = you || member.role === 'owner' || !manage;
            return (
              <SettingsListItem
                key={member.id}
                leading={<Avatar name={member.name} size={28} />}
                title={
                  <>
                    <span className="truncate">{member.email}</span>
                    {you ? <span className="font-normal text-fg-meta">(you)</span> : null}
                    <Tag tone={member.role === 'owner' ? 'brand' : 'neutral'}>
                      {ROLE_LABEL[member.role]}
                    </Tag>
                  </>
                }
                description={
                  member.lastLoginAt
                    ? `Active · Last login ${day(member.lastLoginAt)}`
                    : 'Active · Never signed in'
                }
                actions={
                  locked ? null : (
                    <Menu
                      align="end"
                      trigger={<IconButton icon={MoreHorizontal} label="Member actions" />}
                      actions={[
                        {
                          id: 'role',
                          label: 'Change role',
                          icon: UserCog,
                          onSelect: () => {
                            setNextRole(member.role === 'owner' ? 'admin' : member.role);
                            setEditing(member);
                          },
                        },
                        {
                          id: 'remove',
                          label: 'Remove',
                          icon: Trash2,
                          tone: 'danger',
                          separated: true,
                          onSelect: () => setRemoving(member),
                        },
                      ]}
                    />
                  )
                }
              />
            );
          })
        )}
      </SettingSection>

      <SettingSection
        title="Pending invitations"
        description="Invites that have not been accepted yet"
      >
        {invitations.isPending ? (
          <SkeletonItems count={1} round />
        ) : invitations.isError ? (
          <InlineError error={invitations.error} onRetry={() => void invitations.refetch()} />
        ) : invitations.data.length === 0 ? (
          <SettingsEmpty title="No pending invitations" />
        ) : (
          invitations.data.map((invitation) => (
            <SettingsListItem
              key={invitation.id}
              leading={
                <span className="flex size-7 items-center justify-center rounded-full bg-chip text-fg-muted">
                  <Mail className="size-3.5" />
                </span>
              }
              title={
                <>
                  <span className="truncate">{invitation.email}</span>
                  <Tag>{ROLE_LABEL[invitation.role]}</Tag>
                </>
              }
              description={`Invited ${day(invitation.createdAt)} · ${expires(invitation.expiresAt)}`}
              actions={
                manage ? (
                  <Menu
                    align="end"
                    trigger={<IconButton icon={MoreHorizontal} label="Invitation actions" />}
                    actions={[
                      {
                        id: 'copy',
                        label: 'Copy invite link',
                        icon: Link2,
                        onSelect: () => copyLink(invitation.link),
                      },
                      {
                        id: 'revoke',
                        label: 'Revoke',
                        icon: Trash2,
                        tone: 'danger',
                        separated: true,
                        onSelect: () => setRevoking(invitation),
                      },
                    ]}
                  />
                ) : null
              }
            />
          ))
        )}
      </SettingSection>

      <Dialog
        open={inviting}
        onOpenChange={openInvite}
        title={link ? 'Invite created' : 'Invite a member'}
        description={
          link
            ? 'kimmi does not send email. Copy the link and share it with them yourself.'
            : 'They get a link to create their account on this instance.'
        }
        footer={
          link ? (
            <Button variant="primary" onClick={() => openInvite(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => openInvite(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!validEmail || createInvitation.isPending}
                onClick={invite}
              >
                Invite
              </Button>
            </>
          )
        }
      >
        {link ? (
          <CodeBlock code={link} label={email.trim()} />
        ) : (
          <>
            <Field
              label="Email"
              hint={inviteError ? <span className="text-danger-fg">{inviteError}</span> : undefined}
            >
              <Input
                type="email"
                placeholder="name@company.com"
                value={email}
                aria-invalid={inviteError ? true : undefined}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (createInvitation.isError) createInvitation.reset();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') invite();
                }}
              />
            </Field>
            <Field label="Role" hint={ROLE_HINT[role]}>
              <Select block label="Role" value={role} onChange={setRole} options={ROLES} />
            </Field>
          </>
        )}
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Change role"
        description={editing ? `What ${editing.email} can do on this instance.` : undefined}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={editing?.role === nextRole || changeRole.isPending}
              onClick={() => {
                if (!editing) return;
                changeRole.mutate(
                  { id: editing.id, role: nextRole },
                  {
                    onSuccess: () => {
                      setEditing(null);
                      toast('Role updated');
                    },
                    onError: failed,
                  },
                );
              }}
            >
              Change role
            </Button>
          </>
        }
      >
        <Field label="Role" hint={ROLE_HINT[nextRole]}>
          <Select block label="Role" value={nextRole} onChange={setNextRole} options={ROLES} />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing ? `Remove ${removing.email}` : 'Remove member'}
        description="They lose access right away."
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (!removing) return;
          removeMember.mutate(removing.id, {
            onSuccess: () => toast('Member removed'),
            onError: failed,
          });
        }}
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke invitation"
        description={revoking ? `The invite link for ${revoking.email} stops working.` : ''}
        confirmLabel="Revoke"
        danger
        onConfirm={() => {
          if (!revoking) return;
          revokeInvitation.mutate(revoking.id, {
            onSuccess: () => toast('Invitation revoked'),
            onError: failed,
          });
        }}
      />
    </Page>
  );
}
