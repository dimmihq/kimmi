import { BarChart3, Link2, MoreHorizontal, PlayCircle, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { type Share, useCreateShare, useDeleteShare, useShares } from '@/api/analytics';
import { errorMessage } from '@/api/http';
import { useAnalyticsOn, useMe, useProject } from '@/api/queries';
import { canManage, useProjectSettings, useUpdateProjectSettings } from '@/api/settings';
import { ago, day, duration } from '@/lib/format';
import {
  Button,
  CodeBlock,
  ConfirmDialog,
  Dialog,
  Field,
  IconButton,
  Menu,
  type Option,
  Page,
  Select,
  SettingRow,
  SettingSection,
  SettingsEmpty,
  SettingsHeader,
  SettingsListItem,
  Switch,
  toast,
} from '@/ui';
import { failed, InlineError, Loaded, SectionError, SkeletonItems } from '../settings/parts';

type Expiry = '1' | '7' | '30';

const EXPIRY: Option<Expiry>[] = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
];

const publicLinks = (analytics: boolean) =>
  `Admins can create links that let anyone watch one recording${analytics ? ', or see the analytics page,' : ''} without signing in. Links expire. Masked content stays masked. Turning this off stops every existing link at once.`;

export function SharingSettings() {
  const { projectId = '' } = useParams();
  const isAdmin = canManage(useMe().data?.user.role);
  const project = useProject(projectId);
  const settings = useProjectSettings(projectId);
  const update = useUpdateProjectSettings(projectId);
  const shares = useShares(projectId, isAdmin);
  const createShare = useCreateShare(projectId);
  const deleteShare = useDeleteShare(projectId);
  const sharing = settings.data?.sharing;
  // The analytics page exists, and can be shared, only while visits are counted.
  const analyticsOn = useAnalyticsOn(projectId) === true;

  const [creating, setCreating] = useState(false);
  const [expiry, setExpiry] = useState<Expiry>('7');
  const [link, setLink] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Share | null>(null);

  const openCreate = (open: boolean) => {
    setCreating(open);
    if (!open) {
      setExpiry('7');
      setLink(null);
      createShare.reset();
    }
  };

  const create = () => {
    if (createShare.isPending) return;
    createShare.mutate(
      { kind: 'dashboard', expiresInDays: Number(expiry) as 1 | 7 | 30 },
      { onSuccess: (share) => setLink(share.link ?? null) },
    );
  };

  return (
    <Page>
      <SettingsHeader
        title="Sharing"
        description={`Links that show ${project.data?.name ?? 'this project'} to people without an account.`}
      />

      {settings.isError ? (
        <SectionError
          title="Public links"
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <>
          <SettingSection title="Public links">
            <SettingRow title="Allow public links" description={publicLinks(analyticsOn)}>
              <Loaded value={sharing} kind="switch">
                {(current) => (
                  <Switch
                    label="Allow public links"
                    disabled={!isAdmin}
                    checked={current.enabled}
                    onChange={(enabled) =>
                      update.mutate(
                        { sharing: { enabled } },
                        { onSuccess: () => toast('Saved'), onError: failed },
                      )
                    }
                  />
                )}
              </Loaded>
            </SettingRow>
          </SettingSection>

          {analyticsOn ? (
            <SettingSection title="Analytics link">
              <SettingRow
                title="Share the analytics page"
                description="Anyone with the link sees visits, sources and pages. Recordings are not included."
              >
                <Button
                  icon={Link2}
                  disabled={!isAdmin || !sharing?.enabled}
                  onClick={() => setCreating(true)}
                >
                  Create link
                </Button>
              </SettingRow>
            </SettingSection>
          ) : null}
        </>
      )}

      <SettingSection title="Active links">
        {!isAdmin ? (
          <p className="px-5 py-4 text-meta text-fg-meta">Only admins can manage public links.</p>
        ) : shares.isPending ? (
          <SkeletonItems count={2} />
        ) : shares.isError ? (
          <InlineError error={shares.error} onRetry={() => void shares.refetch()} />
        ) : shares.data.length === 0 ? (
          <SettingsEmpty
            icon={Link2}
            title="No active links"
            description={
              analyticsOn
                ? 'Links to a recording or to the analytics page are listed here until they expire.'
                : 'Links to a recording are listed here until they expire.'
            }
          />
        ) : (
          shares.data.map((share) => {
            const recording = share.kind === 'recording';
            const Icon = recording ? PlayCircle : BarChart3;
            return (
              <SettingsListItem
                key={share.id}
                leading={
                  <span className="flex size-7 items-center justify-center rounded-md bg-chip text-fg-muted">
                    <Icon className="size-3.5" />
                  </span>
                }
                title={
                  recording ? (
                    <Link
                      to={`/projects/${projectId}/recordings/${share.recordingId}?t=${Math.floor(share.startMs / 1000)}`}
                      className="truncate hover:underline hover:underline-offset-2"
                    >
                      Recording · starts at {duration(share.startMs)}
                    </Link>
                  ) : (
                    <span className="truncate">Analytics</span>
                  )
                }
                description={`Created by ${share.author} ${ago(share.createdAt)} · expires ${day(share.expiresAt)}`}
                actions={
                  <Menu
                    align="end"
                    trigger={<IconButton icon={MoreHorizontal} label="Link actions" />}
                    actions={[
                      {
                        id: 'revoke',
                        label: 'Revoke',
                        icon: Trash2,
                        tone: 'danger',
                        onSelect: () => setRevoking(share),
                      },
                    ]}
                  />
                }
              />
            );
          })
        )}
      </SettingSection>

      <Dialog
        open={creating}
        onOpenChange={openCreate}
        title={link ? 'Link created' : 'Create link'}
        description={
          link
            ? 'Copy the link now. It is not shown again.'
            : 'Anyone with the link can see the analytics page until it expires.'
        }
        footer={
          link ? (
            <Button variant="primary" onClick={() => openCreate(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => openCreate(false)}>Cancel</Button>
              <Button variant="primary" disabled={createShare.isPending} onClick={create}>
                Create link
              </Button>
            </>
          )
        }
      >
        {link ? (
          <CodeBlock code={link} label="Analytics" />
        ) : (
          <Field
            label="Expires in"
            hint={
              createShare.isError ? (
                <span className="text-danger-fg">{errorMessage(createShare.error)}</span>
              ) : undefined
            }
          >
            <Select block label="Expires in" value={expiry} onChange={setExpiry} options={EXPIRY} />
          </Field>
        )}
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke link?"
        description="The link stops working right away. This cannot be undone."
        confirmLabel="Revoke"
        danger
        onConfirm={() => {
          if (!revoking) return;
          deleteShare.mutate(revoking.id, {
            onSuccess: () => toast('Link revoked'),
            onError: failed,
          });
        }}
      />
    </Page>
  );
}
