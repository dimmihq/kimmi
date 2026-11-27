import { Globe, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useProject } from '@/api/queries';
import { useDeleteProject, useSetOrigins, useUpdateProject } from '@/api/settings';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  IconButton,
  Input,
  Page,
  Select,
  SettingRow,
  SettingSection,
  SettingsEmpty,
  SettingsHeader,
  SettingsListItem,
  toast,
} from '@/ui';
import {
  failed,
  fieldError,
  Loaded,
  SavingInput,
  SectionError,
  SkeletonItems,
  withValue,
} from '../settings/parts';

const TIME_ZONES = [
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'Africa/Lagos', label: 'Lagos' },
  { value: 'America/New_York', label: 'New York' },
  { value: 'America/Los_Angeles', label: 'Los Angeles' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
];

function toOrigin(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.includes('.') || url.hostname === 'localhost' ? url.origin : null;
  } catch {
    return null;
  }
}

export function General() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const project = useProject(projectId);
  const current = project.data;
  const updateProject = useUpdateProject(projectId);
  const setOrigins = useSetOrigins(projectId);
  const deleteProject = useDeleteProject(projectId);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const origins = current?.origins ?? [];
  const origin = toOrigin(draft);
  const duplicate = origin !== null && origins.includes(origin);
  const addError = setOrigins.error ? fieldError(setOrigins.error, 'origins') : null;

  const closeAdd = (open: boolean) => {
    setAdding(open);
    if (!open) {
      setDraft('');
      setOrigins.reset();
    }
  };

  const addOrigin = () => {
    if (!origin || duplicate || setOrigins.isPending) return;
    setOrigins.mutate([...origins, origin], {
      onSuccess: () => {
        closeAdd(false);
        toast('Origin added');
      },
    });
  };

  const removeOrigin = (entry: string) =>
    setOrigins.mutate(
      origins.filter((value) => value !== entry),
      { onSuccess: () => toast('Origin removed'), onError: failed },
    );

  const name = current?.name ?? 'this project';

  return (
    <Page>
      <SettingsHeader title="General" description={`The name, address and time zone of ${name}.`} />

      {project.isError && !current ? (
        <SectionError
          title="Project details"
          description="How this project appears in kimmi."
          error={project.error}
          onRetry={() => void project.refetch()}
        />
      ) : (
        <>
          <SettingSection title="Project details" description="How this project appears in kimmi.">
            <SettingRow
              title="Name"
              description="Shown in the sidebar and the project list."
              htmlFor="project-name"
            >
              <Loaded value={current}>
                {(entry) => (
                  <SavingInput
                    key={entry.id}
                    id="project-name"
                    field="name"
                    value={entry.name}
                    onSave={(next) => updateProject.mutateAsync({ name: next.trim() })}
                  />
                )}
              </Loaded>
            </SettingRow>
            <SettingRow
              title="Slug"
              description="Used in links to this project. Old links stop working when it changes."
              htmlFor="project-slug"
            >
              <Loaded value={current}>
                {(entry) => (
                  <SavingInput
                    key={entry.id}
                    id="project-slug"
                    mono
                    field="slug"
                    value={entry.slug}
                    onSave={(next) => updateProject.mutateAsync({ slug: next.trim() })}
                  />
                )}
              </Loaded>
            </SettingRow>
            <SettingRow title="Time zone" description="Dates and daily totals use this time zone.">
              <Loaded value={current}>
                {(entry) => (
                  <Select
                    block
                    label="Time zone"
                    value={entry.timezone}
                    onChange={(timezone) =>
                      updateProject.mutate(
                        { timezone },
                        { onSuccess: () => toast('Saved'), onError: failed },
                      )
                    }
                    options={withValue(TIME_ZONES, entry.timezone, entry.timezone)}
                  />
                )}
              </Loaded>
            </SettingRow>
          </SettingSection>

          <SettingSection
            title="Allowed origins"
            description="Only these sites may send recordings with this project's key."
            actions={
              <Button
                size="sm"
                icon={Plus}
                disabled={!current}
                onClick={() => {
                  setOrigins.reset();
                  setAdding(true);
                }}
              >
                Add origin
              </Button>
            }
          >
            {!current ? (
              <SkeletonItems count={2} />
            ) : origins.length === 0 ? (
              <SettingsEmpty
                icon={Globe}
                title="No origins"
                description="Recordings are accepted from every site until you add one."
              />
            ) : (
              origins.map((entry) => (
                <SettingsListItem
                  key={entry}
                  title={<span className="truncate font-mono text-mono font-normal">{entry}</span>}
                  actions={
                    <IconButton
                      icon={X}
                      label="Remove origin"
                      disabled={setOrigins.isPending}
                      onClick={() => removeOrigin(entry)}
                    />
                  }
                />
              ))
            )}
          </SettingSection>

          <SettingSection title="Danger zone" destructive>
            <SettingRow
              title="Delete project"
              description="Deletes the project, its recordings and its settings. This cannot be undone."
            >
              <Button
                variant="danger"
                icon={Trash2}
                disabled={!current || deleteProject.isPending}
                onClick={() => setConfirmDelete(true)}
              >
                Delete project
              </Button>
            </SettingRow>
          </SettingSection>
        </>
      )}

      <Dialog
        open={adding}
        onOpenChange={closeAdd}
        title="Add origin"
        description="Recordings sent from this site are accepted."
        footer={
          <>
            <Button onClick={() => closeAdd(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!origin || duplicate || setOrigins.isPending}
              onClick={addOrigin}
            >
              Add origin
            </Button>
          </>
        }
      >
        <Field
          label="URL"
          hint={
            addError ? (
              <span className="text-danger-fg">{addError}</span>
            ) : duplicate ? (
              'This origin is already allowed.'
            ) : (
              'Scheme and host only, for example https://shop.example.com.'
            )
          }
        >
          <Input
            autoFocus
            mono
            placeholder="https://shop.example.com"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (setOrigins.isError) setOrigins.reset();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addOrigin();
            }}
          />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${name}?`}
        description="Every recording and setting of this project is deleted. This cannot be undone."
        confirmLabel="Delete project"
        danger
        onConfirm={() =>
          deleteProject.mutate(undefined, {
            onSuccess: () => {
              toast('Project deleted');
              navigate('/projects');
            },
            onError: failed,
          })
        }
      />
    </Page>
  );
}
