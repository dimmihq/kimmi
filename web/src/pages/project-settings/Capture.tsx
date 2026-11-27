import { Link2, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useProject } from '@/api/queries';
import { useProjectSettings, useUpdateProjectSettings } from '@/api/settings';
import type { CaptureSettings, UrlRule } from '@/api/types';
import {
  Button,
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
  Switch,
  toast,
} from '@/ui';
import { failed, Loaded, SectionError, SkeletonItems, withValue } from '../settings/parts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const options = (...pairs: [number, string][]) =>
  pairs.map(([value, label]) => ({ value: String(value), label }));

const SAMPLE_RATES = options(
  [100, '100%'],
  [50, '50%'],
  [25, '25%'],
  [10, '10%'],
  [5, '5%'],
  [1, '1%'],
);
const MIN_DURATIONS = options(
  [0, 'No minimum'],
  [2 * SECOND, '2 seconds'],
  [5 * SECOND, '5 seconds'],
  [10 * SECOND, '10 seconds'],
  [30 * SECOND, '30 seconds'],
);
const IDLE_TIMEOUTS = options(
  [5 * MINUTE, '5 minutes'],
  [15 * MINUTE, '15 minutes'],
  [30 * MINUTE, '30 minutes'],
  [60 * MINUTE, '1 hour'],
);
const MAX_LENGTHS = options(
  [30 * MINUTE, '30 minutes'],
  [60 * MINUTE, '1 hour'],
  [120 * MINUTE, '2 hours'],
  [240 * MINUTE, '4 hours'],
);

/** A stored value the choices do not offer, labelled plainly. */
const msLabel = (ms: number) =>
  ms % MINUTE === 0 ? `${ms / MINUTE} minutes` : `${ms / SECOND} seconds`;

type MatchType = UrlRule['type'];

const MATCH_OPTIONS: { value: MatchType; label: string }[] = [
  { value: 'contains', label: 'Contains' },
  { value: 'matches', label: 'Matches' },
];

const MATCH_LABEL: Record<MatchType, string> = { contains: 'Contains', matches: 'Matches' };

type NumberField = 'sampleRate' | 'minDurationMs' | 'idleTimeoutMs' | 'maxLengthMs';

const SAMPLING: {
  id: NumberField;
  title: string;
  hint: string;
  choices: { value: string; label: string }[];
  label: (value: number) => string;
}[] = [
  {
    id: 'sampleRate',
    title: 'Sample rate',
    hint: 'The share of visits that are recorded. The rest are not sent.',
    choices: SAMPLE_RATES,
    label: (value) => `${value}%`,
  },
  {
    id: 'minDurationMs',
    title: 'Minimum duration',
    hint: 'Shorter visits are dropped before they are stored.',
    choices: MIN_DURATIONS,
    label: msLabel,
  },
  {
    id: 'idleTimeoutMs',
    title: 'Idle timeout',
    hint: 'A recording ends after this long without activity. The next action starts a new one.',
    choices: IDLE_TIMEOUTS,
    label: msLabel,
  },
  {
    id: 'maxLengthMs',
    title: 'Maximum length',
    hint: 'Recording stops when a visit reaches this length.',
    choices: MAX_LENGTHS,
    label: msLabel,
  },
];

const SIGNALS = [
  {
    id: 'console',
    title: 'Console logs',
    hint: 'Logs, warnings and errors appear beside the recording.',
  },
  {
    id: 'network',
    title: 'Network requests',
    hint: 'Records the URL, method, status and timing of each request.',
  },
  {
    id: 'networkBodies',
    title: 'Request and response bodies',
    hint: 'Stores what each request sent and received. Bodies can hold personal data.',
  },
  {
    id: 'performance',
    title: 'Performance timings',
    hint: 'Records page load and web vitals for each page view.',
  },
  {
    id: 'frustration',
    title: 'Rage and dead clicks',
    hint: 'Marks repeated clicks and clicks that did nothing.',
  },
  {
    id: 'crossOriginIframes',
    title: 'Cross-origin iframes',
    hint: 'Records frames from other sites that also run kimmi.',
  },
] as const;

export function Capture() {
  const { projectId = '' } = useParams();
  const project = useProject(projectId);
  const settings = useProjectSettings(projectId);
  const update = useUpdateProjectSettings(projectId);
  const capture = settings.data?.capture;

  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<MatchType>('contains');
  const [pattern, setPattern] = useState('');

  /** Every control applies at once, shown before the server answers. */
  const save = (patch: Partial<CaptureSettings>, done = 'Saved') =>
    update.mutate({ capture: patch }, { onSuccess: () => toast(done), onError: failed });

  const closeAdd = (open: boolean) => {
    setAdding(open);
    if (!open) setPattern('');
  };

  const addRule = () => {
    const value = pattern.trim();
    if (!value || !capture) return;
    save({ urlRules: [...capture.urlRules, { type, pattern: value }] }, 'Rule added');
    closeAdd(false);
  };

  const removeRule = (index: number) => {
    if (!capture) return;
    save({ urlRules: capture.urlRules.filter((_, at) => at !== index) }, 'Rule removed');
  };

  return (
    <Page>
      <SettingsHeader
        title="Capture"
        description={`Which visits to ${project.data?.name ?? 'this project'} are recorded, and what each recording includes.`}
      />

      {settings.isError ? (
        <SectionError
          title="Sampling"
          description="How many visits are recorded, and for how long."
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <>
          <SettingSection title="Sampling" description="How many visits are recorded, and for how long.">
            {SAMPLING.map((entry) => (
              <SettingRow key={entry.id} title={entry.title} description={entry.hint}>
                <Loaded value={capture}>
                  {(current) => (
                    <Select
                      block
                      label={entry.title}
                      value={String(current[entry.id])}
                      onChange={(next) => save({ [entry.id]: Number(next) })}
                      options={withValue(
                        entry.choices,
                        String(current[entry.id]),
                        entry.label(current[entry.id]),
                      )}
                    />
                  )}
                </Loaded>
              </SettingRow>
            ))}
          </SettingSection>

          <SettingSection
            title="Record only when"
            description="With URL rules, only visits that open a matching page are recorded."
            actions={
              <Button size="sm" icon={Plus} disabled={!capture} onClick={() => setAdding(true)}>
                Add rule
              </Button>
            }
          >
            <SettingRow
              title="Start on error"
              description="Recording stays in the browser and is sent only when an error happens."
            >
              <Loaded value={capture} kind="switch">
                {(current) => (
                  <Switch
                    label="Start on error"
                    checked={current.startOnError}
                    onChange={(startOnError) => save({ startOnError })}
                  />
                )}
              </Loaded>
            </SettingRow>
            {!capture ? (
              <SkeletonItems count={1} />
            ) : capture.urlRules.length === 0 ? (
              <SettingsEmpty
                icon={Link2}
                title="No URL rules"
                description="Every page is recorded. Add a rule to record only some of them."
              />
            ) : (
              capture.urlRules.map((rule, index) => (
                <SettingsListItem
                  key={`${index}:${rule.type}:${rule.pattern}`}
                  title={<span className="truncate font-mono text-mono font-normal">{rule.pattern}</span>}
                  description={MATCH_LABEL[rule.type]}
                  actions={
                    <IconButton icon={X} label="Remove rule" onClick={() => removeRule(index)} />
                  }
                />
              ))
            )}
          </SettingSection>

          <SettingSection title="What gets recorded" description="Extra signals stored with each recording.">
            {SIGNALS.map((signal) => (
              <SettingRow key={signal.id} title={signal.title} description={signal.hint}>
                <Loaded value={capture} kind="switch">
                  {(current) => (
                    <Switch
                      label={signal.title}
                      checked={current[signal.id]}
                      onChange={(next) => save({ [signal.id]: next })}
                    />
                  )}
                </Loaded>
              </SettingRow>
            ))}
          </SettingSection>
        </>
      )}

      <Dialog
        open={adding}
        onOpenChange={closeAdd}
        title="Add rule"
        description="Visits that open a matching page are recorded."
        footer={
          <>
            <Button onClick={() => closeAdd(false)}>Cancel</Button>
            <Button variant="primary" disabled={!pattern.trim()} onClick={addRule}>
              Add rule
            </Button>
          </>
        }
      >
        <Field label="Match type">
          <Select block label="Match type" value={type} onChange={setType} options={MATCH_OPTIONS} />
        </Field>
        <Field
          label="Pattern"
          hint={
            type === 'contains'
              ? 'Part of the page path, for example /checkout.'
              : 'A regular expression tested against the page path.'
          }
        >
          <Input
            mono
            placeholder={type === 'contains' ? '/checkout' : '^/account/.*'}
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addRule();
            }}
          />
        </Field>
      </Dialog>
    </Page>
  );
}
