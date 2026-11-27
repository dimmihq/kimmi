import { Filter, MoreHorizontal, Pencil, Plus, Target, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAnalyticsOn, useMe, useProject } from '@/api/queries';
import { canManage, useProjectSettings, useUpdateProjectSettings } from '@/api/settings';
import type {
  AnalyticsSettings as Analytics,
  FunnelSetting,
  GoalSetting,
  StepSetting,
} from '@/api/types';
import { fieldHint, FormError, formErrors } from '@/shell/states';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  IconButton,
  Input,
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
  Tooltip,
} from '@/ui';
import { failed, Loaded, SectionError, SkeletonItems, withValue } from '../settings/parts';

type StepKind = StepSetting['kind'];

const MAX_GOALS = 20;
const MAX_FUNNELS = 10;
const MIN_STEPS = 2;
const MAX_STEPS = 6;

const PERIODS: Option[] = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: '730', label: '2 years' },
];

const GOAL_KINDS: Option<StepKind>[] = [
  { value: 'page', label: 'Views a page' },
  { value: 'event', label: 'Sends an event' },
];

const STEP_KINDS: Option<StepKind>[] = [
  { value: 'page', label: 'Page' },
  { value: 'event', label: 'Event' },
];

const KIND_LABEL: Record<StepKind, string> = { page: 'Page', event: 'Event' };

const COUNTING = [
  {
    id: 'autoEvents',
    title: 'Automatic events',
    hint: 'Counts outbound links, downloads, email and phone links, and form submissions.',
  },
  {
    id: 'heatmaps',
    title: 'Heatmaps',
    hint: 'Records where clicks land on each page.',
  },
] as const;

const code = (text: string) => <code className="font-mono text-mono text-fg-muted">{text}</code>;

interface GoalDraft {
  /** Its place in the list; null for a new goal. */
  index: number | null;
  name: string;
  kind: StepKind;
  value: string;
}

interface FunnelDraft {
  index: number | null;
  name: string;
  steps: StepSetting[];
}

const NEW_GOAL: GoalDraft = { index: null, name: '', kind: 'page', value: '' };
const NEW_FUNNEL: FunnelDraft = {
  index: null,
  name: '',
  steps: [
    { kind: 'page', value: '' },
    { kind: 'page', value: '' },
  ],
};

export function AnalyticsSettings() {
  const { projectId = '' } = useParams();
  const manage = canManage(useMe().data?.user.role);
  const project = useProject(projectId);
  const settings = useProjectSettings(projectId);
  const update = useUpdateProjectSettings(projectId);
  const analytics = settings.data?.analytics;
  const counted = useAnalyticsOn(projectId);
  // The switch itself answers first; before the settings load, the project does.
  const on = analytics ? analytics.enabled : counted === true;
  const feedback = settings.data?.feedback;
  const goals = analytics?.goals ?? [];
  const funnels = analytics?.funnels ?? [];

  const [goalOpen, setGoalOpen] = useState(false);
  const [goal, setGoal] = useState<GoalDraft>(NEW_GOAL);
  const [goalError, setGoalError] = useState<unknown>(null);
  const [funnelOpen, setFunnelOpen] = useState(false);
  const [funnel, setFunnel] = useState<FunnelDraft>(NEW_FUNNEL);
  const [funnelError, setFunnelError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [deletingGoal, setDeletingGoal] = useState<GoalSetting | null>(null);
  const [deletingFunnel, setDeletingFunnel] = useState<FunnelSetting | null>(null);
  // The confirmations keep their name while they close.
  const [lastGoal, setLastGoal] = useState<GoalSetting | null>(null);
  const [lastFunnel, setLastFunnel] = useState<FunnelSetting | null>(null);

  /** Switches and selects apply at once, shown before the server answers. */
  const save = (patch: Partial<Analytics>, done = 'Saved') =>
    update.mutate({ analytics: patch }, { onSuccess: () => toast(done), onError: failed });

  /* ------------------------------------------------------------------ Goals */

  const openGoal = (draft: GoalDraft) => {
    setGoal(draft);
    setGoalError(null);
    setGoalOpen(true);
  };

  const editGoal = (patch: Partial<GoalDraft>) => {
    setGoal((current) => ({ ...current, ...patch }));
    setGoalError(null);
  };

  const goalAt = goal.index ?? goals.length;
  const goalReady = goal.name.trim() !== '' && goal.value.trim() !== '';
  const goalErrors = formErrors(goalError);

  const saveGoal = async () => {
    if (!goalReady || saving) return;
    const entry: GoalSetting = {
      id: goal.index === null ? '' : (goals[goal.index]?.id ?? ''),
      name: goal.name.trim(),
      kind: goal.kind,
      value: goal.value.trim(),
    };
    const next = goal.index === null ? [...goals, entry] : goals.map((old, at) => (at === goal.index ? entry : old));
    setSaving(true);
    try {
      await update.mutateAsync({ analytics: { goals: next } });
      setGoalOpen(false);
      toast(goal.index === null ? 'Goal added' : 'Goal saved');
    } catch (error) {
      setGoalError(error);
    } finally {
      setSaving(false);
    }
  };

  /* ---------------------------------------------------------------- Funnels */

  const openFunnel = (draft: FunnelDraft) => {
    setFunnel(draft);
    setFunnelError(null);
    setFunnelOpen(true);
  };

  const editFunnel = (patch: Partial<FunnelDraft>) => {
    setFunnel((current) => ({ ...current, ...patch }));
    setFunnelError(null);
  };

  const editStep = (index: number, patch: Partial<StepSetting>) =>
    editFunnel({ steps: funnel.steps.map((step, at) => (at === index ? { ...step, ...patch } : step)) });

  const funnelAt = funnel.index ?? funnels.length;
  const funnelReady =
    funnel.name.trim() !== '' && funnel.steps.every((step) => step.value.trim() !== '');
  const funnelErrors = formErrors(funnelError);

  const saveFunnel = async () => {
    if (!funnelReady || saving) return;
    const entry: FunnelSetting = {
      id: funnel.index === null ? '' : (funnels[funnel.index]?.id ?? ''),
      name: funnel.name.trim(),
      steps: funnel.steps.map((step) => ({ kind: step.kind, value: step.value.trim() })),
    };
    const next =
      funnel.index === null ? [...funnels, entry] : funnels.map((old, at) => (at === funnel.index ? entry : old));
    setSaving(true);
    try {
      await update.mutateAsync({ analytics: { funnels: next } });
      setFunnelOpen(false);
      toast(funnel.index === null ? 'Funnel added' : 'Funnel saved');
    } catch (error) {
      setFunnelError(error);
    } finally {
      setSaving(false);
    }
  };

  const addButton = (label: string, full: boolean, limit: string, onClick: () => void) => {
    const button = (
      <Button size="sm" icon={Plus} disabled={!analytics || full} onClick={onClick}>
        {label}
      </Button>
    );
    // A disabled button takes no pointer, so the tooltip hangs on a wrapper.
    return full ? (
      <Tooltip label={limit}>
        <span>{button}</span>
      </Tooltip>
    ) : (
      button
    );
  };

  return (
    <Page>
      <SettingsHeader
        title="Analytics"
        description={
          on
            ? `How visits to ${project.data?.name ?? 'this project'} are counted, and the goals and funnels measured from them.`
            : `Whether visits to ${project.data?.name ?? 'this project'} are counted.`
        }
      />

      {settings.isError ? (
        <SectionError
          title="Counting"
          description="Applies to visits from now on."
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <>
          <SettingSection
            title="Counting"
            description={
              on
                ? 'What is counted for every visitor, recorded or not.'
                : 'Off by default. A project that only records sessions needs none of this.'
            }
          >
            <SettingRow
              title="Count visits"
              description="Counts page views, where visits come from, clicks, errors and page speed for every visitor, recorded or not, and adds Analytics, Funnels, Heatmaps, Errors, Friction, Performance and Feedback to this project. No page content is kept."
            >
              <Loaded value={analytics} kind="switch">
                {(current) => (
                  <Switch
                    label="Count visits"
                    disabled={!manage}
                    checked={current.enabled}
                    onChange={(enabled) => save({ enabled })}
                  />
                )}
              </Loaded>
            </SettingRow>
            {on ? (
              <>
                <SettingRow
                  title="Cookieless counting"
                  description={
                    <>
                      Count visits without storing anything in the visitor's browser. A daily hash of
                      the address and browser tells visitors apart and is thrown away each night, so a
                      returning visitor counts again the next day. Recording still needs storage: with
                      this on, recordings start only after you call {code('kimmi.optIn()')}.
                    </>
                  }
                >
                  <Loaded value={analytics} kind="switch">
                    {(current) => (
                      <Switch
                        label="Cookieless counting"
                        disabled={!manage}
                        checked={current.cookieless}
                        onChange={(cookieless) => save({ cookieless })}
                      />
                    )}
                  </Loaded>
                </SettingRow>
                {COUNTING.map((entry) => (
                  <SettingRow key={entry.id} title={entry.title} description={entry.hint}>
                    <Loaded value={analytics} kind="switch">
                      {(current) => (
                        <Switch
                          label={entry.title}
                          disabled={!manage}
                          checked={current[entry.id]}
                          onChange={(next) => save({ [entry.id]: next })}
                        />
                      )}
                    </Loaded>
                  </SettingRow>
                ))}
                <SettingRow
                  title="Keep analytics for"
                  description="Visit counts and events older than this are deleted."
                >
                  <Loaded value={analytics}>
                    {(current) => {
                      const value = String(current.retentionDays);
                      const choices = withValue(PERIODS, value, `${value} days`);
                      return manage ? (
                        <Select
                          block
                          label="Keep analytics for"
                          value={value}
                          onChange={(next) =>
                            save({ retentionDays: Number(next) as Analytics['retentionDays'] })
                          }
                          options={choices}
                        />
                      ) : (
                        <p className="text-control text-fg-meta">
                          {choices.find((choice) => choice.value === value)?.label}
                        </p>
                      );
                    }}
                  </Loaded>
                </SettingRow>
              </>
            ) : null}
          </SettingSection>

          {on ? (
            <>
              <SettingSection title="Feedback" description="Let visitors tell you what went wrong.">
                <SettingRow
                  title="Feedback button"
                  description={
                    <>
                      Where a small Feedback button sits on your site. Hidden shows none: call{' '}
                      {code("kimmi.feedback('...')")} from a button of your own. Messages arrive with
                      the session they were sent from.
                    </>
                  }
                >
                  <Loaded value={feedback} kind="field">
                    {(current) => {
                      const places = [
                        { value: 'hidden', label: 'Hidden' },
                        { value: 'bottom-right', label: 'Bottom right' },
                        { value: 'bottom-left', label: 'Bottom left' },
                      ];
                      return manage ? (
                        <Select
                          block
                          label="Feedback button"
                          value={current.button}
                          onChange={(button) =>
                            update.mutate(
                              { feedback: { button: button as typeof current.button } },
                              { onSuccess: () => toast('Saved'), onError: failed },
                            )
                          }
                          options={places}
                        />
                      ) : (
                        <p className="text-control text-fg-meta">
                          {places.find((place) => place.value === current.button)?.label}
                        </p>
                      );
                    }}
                  </Loaded>
                </SettingRow>
              </SettingSection>

              <SettingSection
                title="Goals"
                description="A visit converts when it views a page or sends an event."
                actions={
                  manage
                    ? addButton(
                        'Add goal',
                        goals.length >= MAX_GOALS,
                        `A project has at most ${MAX_GOALS} goals`,
                        () => openGoal(NEW_GOAL),
                      )
                    : null
                }
              >
                {!analytics ? (
                  <SkeletonItems count={2} />
                ) : goals.length === 0 ? (
                  <SettingsEmpty
                    icon={Target}
                    title="No goals"
                    description="Add a goal to count the visits that reach a page or send an event."
                  />
                ) : (
                  goals.map((entry, index) => (
                    <SettingsListItem
                      key={`${index}:${entry.id}`}
                      title={<span className="truncate">{entry.name}</span>}
                      description={
                        <>
                          {KIND_LABEL[entry.kind]}{' '}
                          <span className="font-mono text-mono">{entry.value}</span>
                        </>
                      }
                      actions={
                        manage ? (
                          <Menu
                            align="end"
                            trigger={<IconButton icon={MoreHorizontal} label="Goal actions" />}
                            actions={[
                              {
                                id: 'edit',
                                label: 'Edit',
                                icon: Pencil,
                                onSelect: () =>
                                  openGoal({
                                    index,
                                    name: entry.name,
                                    kind: entry.kind,
                                    value: entry.value,
                                  }),
                              },
                              {
                                id: 'delete',
                                label: 'Delete',
                                icon: Trash2,
                                tone: 'danger',
                                separated: true,
                                onSelect: () => {
                                  setDeletingGoal(entry);
                                  setLastGoal(entry);
                                },
                              },
                            ]}
                          />
                        ) : null
                      }
                    />
                  ))
                )}
              </SettingSection>

              <SettingSection
                title="Funnels"
                description="Steps a visit takes in order, to see where visitors stop."
                actions={
                  manage
                    ? addButton(
                        'Add funnel',
                        funnels.length >= MAX_FUNNELS,
                        `A project has at most ${MAX_FUNNELS} funnels`,
                        () => openFunnel(NEW_FUNNEL),
                      )
                    : null
                }
              >
                {!analytics ? (
                  <SkeletonItems count={2} />
                ) : funnels.length === 0 ? (
                  <SettingsEmpty
                    icon={Filter}
                    title="No funnels"
                    description="Add a funnel of two to six pages or events to see where visitors drop off."
                  />
                ) : (
                  funnels.map((entry, index) => (
                    <SettingsListItem
                      key={`${index}:${entry.id}`}
                      title={<span className="truncate">{entry.name}</span>}
                      description={
                        <span className="font-mono text-mono">
                          {entry.steps.map((step) => step.value).join(' → ')}
                        </span>
                      }
                      actions={
                        manage ? (
                          <Menu
                            align="end"
                            trigger={<IconButton icon={MoreHorizontal} label="Funnel actions" />}
                            actions={[
                              {
                                id: 'edit',
                                label: 'Edit',
                                icon: Pencil,
                                onSelect: () =>
                                  openFunnel({
                                    index,
                                    name: entry.name,
                                    steps: entry.steps.map((step) => ({ ...step })),
                                  }),
                              },
                              {
                                id: 'delete',
                                label: 'Delete',
                                icon: Trash2,
                                tone: 'danger',
                                separated: true,
                                onSelect: () => {
                                  setDeletingFunnel(entry);
                                  setLastFunnel(entry);
                                },
                              },
                            ]}
                          />
                        ) : null
                      }
                    />
                  ))
                )}
              </SettingSection>
            </>
          ) : null}
        </>
      )}

      <Dialog
        open={goalOpen}
        onOpenChange={setGoalOpen}
        title={goal.index === null ? 'Add goal' : 'Edit goal'}
        description="A visit converts when it views the page or sends the event."
        footer={
          <>
            <Button onClick={() => setGoalOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!goalReady || saving} onClick={() => void saveGoal()}>
              {goal.index === null ? 'Add goal' : 'Save'}
            </Button>
          </>
        }
      >
        <Field label="Name" hint={fieldHint(goalErrors.fields[`analytics.goals.${goalAt}.name`])}>
          <Input
            placeholder="Signed up"
            value={goal.name}
            aria-invalid={goalErrors.fields[`analytics.goals.${goalAt}.name`] ? true : undefined}
            onChange={(event) => editGoal({ name: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveGoal();
            }}
          />
        </Field>
        <Field label="Counts when a visitor">
          <Select
            block
            label="Counts when a visitor"
            value={goal.kind}
            onChange={(kind) => editGoal({ kind })}
            options={GOAL_KINDS}
          />
        </Field>
        <Field
          label={goal.kind === 'page' ? 'Page path' : 'Event name'}
          hint={fieldHint(
            goalErrors.fields[`analytics.goals.${goalAt}.value`],
            goal.kind === 'page'
              ? 'End with * to match everything under a path.'
              : 'The name you pass to kimmi.track.',
          )}
        >
          <Input
            mono
            placeholder={goal.kind === 'page' ? '/thanks' : 'signup'}
            value={goal.value}
            aria-invalid={goalErrors.fields[`analytics.goals.${goalAt}.value`] ? true : undefined}
            onChange={(event) => editGoal({ value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveGoal();
            }}
          />
        </Field>
        <FormError message={goalErrors.message} />
      </Dialog>

      <Dialog
        open={funnelOpen}
        onOpenChange={setFunnelOpen}
        title={funnel.index === null ? 'Add funnel' : 'Edit funnel'}
        description="Two to six pages or events, in the order a visit reaches them."
        width={480}
        footer={
          <>
            <Button onClick={() => setFunnelOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!funnelReady || saving}
              onClick={() => void saveFunnel()}
            >
              {funnel.index === null ? 'Add funnel' : 'Save'}
            </Button>
          </>
        }
      >
        <Field
          label="Name"
          hint={fieldHint(funnelErrors.fields[`analytics.funnels.${funnelAt}.name`])}
        >
          <Input
            placeholder="Checkout"
            value={funnel.name}
            aria-invalid={funnelErrors.fields[`analytics.funnels.${funnelAt}.name`] ? true : undefined}
            onChange={(event) => editFunnel({ name: event.target.value })}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-label text-fg-secondary">Steps</span>
          {funnel.steps.map((step, index) => {
            const stepError = funnelErrors.fields[`analytics.funnels.${funnelAt}.steps.${index}`];
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps have no identity but their place
              <div key={index}>
                <div className="flex items-center gap-2">
                  <Select
                    label={`Step ${index + 1} kind`}
                    value={step.kind}
                    onChange={(kind) => editStep(index, { kind })}
                    options={STEP_KINDS}
                    className="w-24 shrink-0"
                  />
                  <Input
                    mono
                    aria-label={`Step ${index + 1}`}
                    aria-invalid={stepError ? true : undefined}
                    placeholder={step.kind === 'page' ? '/pricing' : 'signup'}
                    value={step.value}
                    onChange={(event) => editStep(index, { value: event.target.value })}
                  />
                  <IconButton
                    icon={X}
                    label="Remove step"
                    disabled={funnel.steps.length <= MIN_STEPS}
                    onClick={() =>
                      editFunnel({ steps: funnel.steps.filter((_, at) => at !== index) })
                    }
                  />
                </div>
                {stepError ? <p className="mt-1.5 text-hint text-danger-fg">{stepError}</p> : null}
              </div>
            );
          })}
          <div>
            <Button
              variant="ghost"
              size="sm"
              icon={Plus}
              disabled={funnel.steps.length >= MAX_STEPS}
              onClick={() => editFunnel({ steps: [...funnel.steps, { kind: 'page', value: '' }] })}
            >
              Add step
            </Button>
          </div>
          <span className="text-hint text-fg-meta">
            A page path may end with * to match everything under it.
          </span>
        </div>
        <FormError message={funnelErrors.message} />
      </Dialog>

      <ConfirmDialog
        open={deletingGoal !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingGoal(null);
        }}
        title={`Delete ${(deletingGoal ?? lastGoal)?.name ?? 'goal'}?`}
        description="The goal is removed from analytics. Recordings and visit counts stay."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (!deletingGoal) return;
          save({ goals: goals.filter((entry) => entry.id !== deletingGoal.id) }, 'Goal deleted');
        }}
      />

      <ConfirmDialog
        open={deletingFunnel !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingFunnel(null);
        }}
        title={`Delete ${(deletingFunnel ?? lastFunnel)?.name ?? 'funnel'}?`}
        description="The funnel is removed from analytics. Recordings and visit counts stay."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (!deletingFunnel) return;
          save({ funnels: funnels.filter((entry) => entry.id !== deletingFunnel.id) }, 'Funnel deleted');
        }}
      />
    </Page>
  );
}
