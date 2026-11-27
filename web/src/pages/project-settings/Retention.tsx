import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useProject } from '@/api/queries';
import {
  useDeleteRecordings,
  useEraseVisitor,
  useProjectSettings,
  useUpdateProjectSettings,
} from '@/api/settings';
import type { ProjectSettings } from '@/api/types';
import { bytes, compact } from '@/lib/format';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Page,
  Select,
  SettingRow,
  SettingSection,
  SettingsHeader,
  Switch,
  toast,
} from '@/ui';
import { failed, fieldError, Loaded, SectionError } from '../settings/parts';

type Days = ProjectSettings['retention']['days'];

const PERIODS: { value: `${Days}`; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

const deletedCount = (deleted: number) =>
  deleted === 0
    ? 'No recordings to delete'
    : `${compact(deleted)} recording${deleted === 1 ? '' : 's'} deleted`;

export function Retention() {
  const { projectId = '' } = useParams();
  const project = useProject(projectId);
  const settings = useProjectSettings(projectId);
  const update = useUpdateProjectSettings(projectId);
  const eraseVisitor = useEraseVisitor(projectId);
  const deleteRecordings = useDeleteRecordings(projectId);
  const retention = settings.data?.retention;

  const [deletingVisitor, setDeletingVisitor] = useState(false);
  const [visitor, setVisitor] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);

  const name = project.data?.name ?? 'this project';
  const stored = project.data ? bytes(project.data.stats.storageBytes) : null;
  const eraseError = eraseVisitor.error ? fieldError(eraseVisitor.error, 'query') : null;

  const save = (patch: Partial<ProjectSettings['retention']>) =>
    update.mutate({ retention: patch }, { onSuccess: () => toast('Saved'), onError: failed });

  const closeVisitor = (open: boolean) => {
    setDeletingVisitor(open);
    if (!open) {
      setVisitor('');
      eraseVisitor.reset();
    }
  };

  const deleteVisitor = () => {
    const query = visitor.trim();
    if (!query || eraseVisitor.isPending) return;
    eraseVisitor.mutate(query, {
      onSuccess: ({ deleted }) => {
        closeVisitor(false);
        toast(deletedCount(deleted));
      },
    });
  };

  return (
    <Page>
      <SettingsHeader
        title="Retention"
        description={`How long kimmi keeps recordings of ${name}, and how to delete them sooner.`}
      />

      {settings.isError ? (
        <SectionError
          title="Retention"
          description="Applies to existing recordings too."
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <>
          <SettingSection title="Retention" description="Applies to existing recordings too.">
            <SettingRow
              title="Keep recordings for"
              description={`Older recordings are deleted at the nightly cleanup.${stored ? ` This project stores ${stored}.` : ''}`}
            >
              <Loaded value={retention}>
                {(current) => (
                  <Select
                    block
                    label="Keep recordings for"
                    value={String(current.days) as `${Days}`}
                    onChange={(next) => save({ days: Number(next) as Days })}
                    options={PERIODS}
                  />
                )}
              </Loaded>
            </SettingRow>
            <SettingRow
              title="Keep starred recordings"
              description="Starred recordings are kept until someone removes the star."
            >
              <Loaded value={retention} kind="switch">
                {(current) => (
                  <Switch
                    label="Keep starred recordings"
                    checked={current.keepStarred}
                    onChange={(keepStarred) => save({ keepStarred })}
                  />
                )}
              </Loaded>
            </SettingRow>
          </SettingSection>
          <p className="mt-3 text-meta text-fg-meta">
            Visit counts and events are kept separately: see{' '}
            <Link
              to={`/projects/${projectId}/settings/analytics`}
              className="text-fg-secondary underline underline-offset-2 hover:text-fg"
            >
              Analytics
            </Link>
            .
          </p>
        </>
      )}

      <SettingSection title="Delete data" description="Deleted recordings cannot be restored.">
        <SettingRow
          title="Delete a visitor's data"
          description="Deletes every recording of one visitor, for example after a deletion request."
        >
          <Button onClick={() => setDeletingVisitor(true)}>Delete visitor data</Button>
        </SettingRow>
        <SettingRow
          title="Delete all recordings"
          description="Deletes every recording in this project, starred ones included. Settings stay."
        >
          <Button
            variant="danger"
            icon={Trash2}
            disabled={deleteRecordings.isPending}
            onClick={() => setConfirmAll(true)}
          >
            Delete all recordings
          </Button>
        </SettingRow>
      </SettingSection>

      <Dialog
        open={deletingVisitor}
        onOpenChange={closeVisitor}
        title="Delete a visitor's data"
        description="Every recording of this visitor is deleted. This cannot be undone."
        footer={
          <>
            <Button onClick={() => closeVisitor(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={!visitor.trim() || eraseVisitor.isPending}
              onClick={deleteVisitor}
            >
              Delete data
            </Button>
          </>
        }
      >
        <Field
          label="Visitor id or email"
          hint={
            eraseError ? (
              <span className="text-danger-fg">{eraseError}</span>
            ) : (
              "The id you pass to kimmi.identify, or the visitor's email."
            )
          }
        >
          <Input
            placeholder="ada@example.com"
            value={visitor}
            aria-invalid={eraseError ? true : undefined}
            onChange={(event) => {
              setVisitor(event.target.value);
              if (eraseVisitor.isError) eraseVisitor.reset();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') deleteVisitor();
            }}
          />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Delete all recordings?"
        description={`Every recording of ${name} is deleted${stored ? `, ${stored} in total` : ''}. This cannot be undone.`}
        confirmLabel="Delete all recordings"
        danger
        onConfirm={() =>
          deleteRecordings.mutate(undefined, {
            onSuccess: ({ deleted }) => toast(deletedCount(deleted)),
            onError: failed,
          })
        }
      />
    </Page>
  );
}
