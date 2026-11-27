import { MoreHorizontal, Plus, UserCog, UserMinus, Users } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMe, useProject } from '@/api/queries';
import {
  canManage,
  useAddProjectMember,
  useChangeProjectMemberRole,
  useMembers,
  useProjectMembers,
  useRemoveProjectMember,
} from '@/api/settings';
import type { ProjectMember, Role } from '@/api/types';
import { ago } from '@/lib/format';
import {
  Avatar,
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  IconButton,
  Menu,
  Page,
  Select,
  SettingSection,
  SettingsEmpty,
  SettingsHeader,
  SettingsListItem,
  Tag,
  toast,
} from '@/ui';
import { failed, InlineError, SkeletonItems } from '../settings/parts';

type AssignableRole = Exclude<Role, 'owner'>;

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

const ROLE_OPTIONS: { value: AssignableRole; label: string }[] = (
  ['admin', 'member', 'viewer'] as const
).map((value) => ({ value, label: ROLE_LABEL[value] }));

const ROLE_HINT: Record<AssignableRole, string> = {
  admin: 'Can watch recordings, change project settings and manage members.',
  member: 'Can watch, share and delete recordings.',
  viewer: 'Can watch recordings and nothing else.',
};

export function ProjectMembers() {
  const { projectId = '' } = useParams();
  const me = useMe().data?.user;
  const manage = canManage(me?.role);
  const project = useProject(projectId);
  const members = useProjectMembers(projectId);
  const workspace = useMembers();
  const addMember = useAddProjectMember(projectId);
  const changeRole = useChangeProjectMemberRole(projectId);
  const removeMember = useRemoveProjectMember(projectId);

  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<AssignableRole>('member');
  const [editing, setEditing] = useState<ProjectMember | null>(null);
  const [removing, setRemoving] = useState<ProjectMember | null>(null);
  // The dialogs keep showing their member while they close.
  const [lastEdited, setLastEdited] = useState<ProjectMember | null>(null);
  const [lastRemoved, setLastRemoved] = useState<ProjectMember | null>(null);

  const name = project.data?.name ?? 'this project';
  const onProject = members.data ?? [];
  const available = (workspace.data ?? []).filter(
    (entry) => !onProject.some((member) => member.userId === entry.id),
  );
  const picked = available.find((entry) => entry.id === pick) ?? available[0];
  const edited = editing ?? lastEdited;
  const removed = removing ?? lastRemoved;

  const openAdd = () => {
    setPick(available[0]?.id ?? '');
    setRole('member');
    setAdding(true);
  };

  const add = () => {
    if (!picked) return;
    addMember.mutate(
      { userId: picked.id, role },
      {
        onSuccess: (member) => {
          setAdding(false);
          toast(`${member.name} added`);
        },
        onError: failed,
      },
    );
  };

  const saveRole = () => {
    if (!editing) return;
    changeRole.mutate(
      { userId: editing.userId, role },
      {
        onSuccess: () => {
          setEditing(null);
          toast('Role changed');
        },
        onError: failed,
      },
    );
  };

  return (
    <Page>
      <SettingsHeader
        title="Members"
        description={`Who can open ${name}. Workspace owners can open every project.`}
        actions={
          manage ? (
            <Button
              variant="primary"
              icon={Plus}
              disabled={!members.data || !workspace.data}
              onClick={openAdd}
            >
              Add member
            </Button>
          ) : null
        }
      />

      <SettingSection title="Project members">
        {members.isPending ? (
          <SkeletonItems round />
        ) : members.isError ? (
          <InlineError error={members.error} onRetry={() => void members.refetch()} />
        ) : onProject.length === 0 ? (
          <SettingsEmpty icon={Users} title="No members" />
        ) : (
          onProject.map((entry) => {
            const owner = entry.role === 'owner';
            return (
              <SettingsListItem
                key={entry.userId}
                leading={<Avatar name={entry.name} size={30} />}
                title={
                  <>
                    <span className="truncate">
                      {entry.name}
                      {entry.userId === me?.id ? (
                        <span className="font-normal text-fg-meta"> (you)</span>
                      ) : null}
                    </span>
                    {owner ? <Tag tone="brand">Owner</Tag> : null}
                  </>
                }
                description={entry.email}
                meta={
                  <>
                    {owner ? null : <span>{ROLE_LABEL[entry.role]}</span>}
                    <span>
                      {entry.lastActiveAt ? `Active ${ago(entry.lastActiveAt)}` : 'Not active yet'}
                    </span>
                  </>
                }
                actions={
                  owner || !manage ? (
                    <span className="size-[30px]" />
                  ) : (
                    <Menu
                      align="end"
                      trigger={<IconButton icon={MoreHorizontal} label="Member actions" />}
                      actions={[
                        {
                          id: 'role',
                          label: 'Change role',
                          icon: UserCog,
                          onSelect: () => {
                            if (entry.role !== 'owner') setRole(entry.role);
                            setEditing(entry);
                            setLastEdited(entry);
                          },
                        },
                        {
                          id: 'remove',
                          label: 'Remove',
                          icon: UserMinus,
                          tone: 'danger',
                          separated: true,
                          onSelect: () => {
                            setRemoving(entry);
                            setLastRemoved(entry);
                          },
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

      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title="Add member"
        description={`Give someone in your workspace access to ${name}.`}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" disabled={!picked || addMember.isPending} onClick={add}>
              Add member
            </Button>
          </>
        }
      >
        <Field
          label="Member"
          hint={picked ? undefined : 'Everyone in the workspace is already on this project.'}
        >
          {picked ? (
            <Select
              block
              label="Member"
              value={picked.id}
              onChange={setPick}
              options={available.map((entry) => ({
                value: entry.id,
                label: `${entry.name} (${entry.email})`,
              }))}
            />
          ) : (
            <p className="text-control text-fg-meta">No one to add</p>
          )}
        </Field>
        <Field label="Role" hint={ROLE_HINT[role]}>
          <Select block label="Role" value={role} onChange={setRole} options={ROLE_OPTIONS} />
        </Field>
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Change role"
        description={edited ? `${edited.name} (${edited.email})` : undefined}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={role === editing?.role || changeRole.isPending}
              onClick={saveRole}
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="Role" hint={ROLE_HINT[role]}>
          <Select block label="Role" value={role} onChange={setRole} options={ROLE_OPTIONS} />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removed?.name ?? 'member'}?`}
        description={`They lose access to ${name} at once. They stay in the workspace.`}
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (!removing) return;
          const { userId, name: removedName } = removing;
          removeMember.mutate(userId, {
            onSuccess: () => toast(`${removedName} removed`),
            onError: failed,
          });
        }}
      />
    </Page>
  );
}
