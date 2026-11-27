import { useParams } from 'react-router-dom';
import { useProject } from '@/api/queries';
import { useProjectSettings, useUpdateProjectSettings } from '@/api/settings';
import type { PrivacySettings } from '@/api/types';
import {
  Page,
  Select,
  SettingRow,
  SettingSection,
  SettingsHeader,
  Switch,
  toast,
} from '@/ui';
import { failed, Loaded, SavingInput, SectionError } from '../settings/parts';

type IpMode = PrivacySettings['ip'];

const IP_OPTIONS: { value: IpMode; label: string }[] = [
  { value: 'full', label: 'Store full' },
  { value: 'truncate', label: 'Truncate' },
  { value: 'none', label: 'Do not store' },
];

const IP_HINT: Record<IpMode, string> = {
  full: 'The full address is stored with each recording.',
  truncate: 'The last part is removed before storing. Country and city still work.',
  none: 'No address is stored. Recordings have no location.',
};

const MASKING = [
  {
    id: 'maskAllText',
    title: 'Mask all text',
    hint: 'Replaces every character on the page with a block before it leaves the browser.',
  },
  {
    id: 'maskAllInputs',
    title: 'Mask all inputs',
    hint: 'Replaces what visitors type with dots. Applies to every field.',
  },
  {
    id: 'blockMedia',
    title: 'Block images and video',
    hint: 'Records a grey box of the same size instead of the media.',
  },
  {
    id: 'recordCanvas',
    title: 'Record canvas',
    hint: 'Captures canvas drawings as images. Recordings get larger.',
  },
] as const;

type SelectorField = 'maskSelectors' | 'blockSelectors' | 'ignoreSelectors';

const SELECTORS: {
  id: SelectorField;
  title: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    id: 'maskSelectors',
    title: 'Mask',
    hint: 'Text inside these elements is replaced with blocks.',
    placeholder: '.email, [data-private]',
  },
  {
    id: 'blockSelectors',
    title: 'Block',
    hint: 'These elements are not recorded. A grey box takes their place.',
    placeholder: '.card-form',
  },
  {
    id: 'ignoreSelectors',
    title: 'Ignore input',
    hint: 'Typing in these fields is not recorded at all.',
    placeholder: '#search',
  },
];

/** Selectors are edited as one comma-separated line and stored as a list. */
const toText = (selectors: string[]) => selectors.join(', ');
const toList = (text: string) =>
  text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export function Privacy() {
  const { projectId = '' } = useParams();
  const project = useProject(projectId);
  const settings = useProjectSettings(projectId);
  const update = useUpdateProjectSettings(projectId);
  const privacy = settings.data?.privacy;

  /** Switches and selects apply at once, shown before the server answers. */
  const save = (patch: Partial<PrivacySettings>) =>
    update.mutate({ privacy: patch }, { onSuccess: () => toast('Saved'), onError: failed });

  const row = (entry: (typeof MASKING)[number]) => (
    <SettingRow key={entry.id} title={entry.title} description={entry.hint}>
      <Loaded value={privacy} kind="switch">
        {(current) => (
          <Switch
            label={entry.title}
            checked={current[entry.id]}
            onChange={(next) => save({ [entry.id]: next })}
          />
        )}
      </Loaded>
    </SettingRow>
  );

  return (
    <Page>
      <SettingsHeader
        title="Privacy"
        description={`What kimmi hides in recordings of ${project.data?.name ?? 'this project'}. Masking happens in the browser, before anything is sent.`}
      />

      {settings.isError ? (
        <SectionError
          title="Masking"
          description="Applies to recordings made from now on."
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <>
          <SettingSection title="Masking" description="Applies to recordings made from now on.">
            {row(MASKING[0])}
            {row(MASKING[1])}
            <SettingRow
              title="Password fields"
              description="Passwords are never recorded. This cannot be turned off."
            >
              <p className="text-control text-fg-meta">Always masked</p>
            </SettingRow>
            {row(MASKING[2])}
            {row(MASKING[3])}
          </SettingSection>

          <SettingSection
            title="Selectors"
            description="CSS selectors, separated by commas. They apply on top of the masking above."
          >
            {SELECTORS.map((entry) => (
              <SettingRow
                key={entry.id}
                wide
                title={entry.title}
                description={entry.hint}
                htmlFor={`selectors-${entry.id}`}
              >
                <Loaded value={privacy}>
                  {(current) => (
                    <SavingInput
                      id={`selectors-${entry.id}`}
                      mono
                      field={`privacy.${entry.id}`}
                      placeholder={entry.placeholder}
                      value={toText(current[entry.id])}
                      onSave={(text) => update.mutateAsync({ privacy: { [entry.id]: toList(text) } })}
                    />
                  )}
                </Loaded>
              </SettingRow>
            ))}
          </SettingSection>

          <SettingSection title="Visitors" description="What kimmi keeps about the people it records.">
            <SettingRow
              title="IP address"
              description={privacy ? IP_HINT[privacy.ip] : IP_HINT.truncate}
            >
              <Loaded value={privacy}>
                {(current) => (
                  <Select
                    block
                    label="IP address"
                    value={current.ip}
                    onChange={(ip) => save({ ip })}
                    options={IP_OPTIONS}
                  />
                )}
              </Loaded>
            </SettingRow>
            <SettingRow
              title="Scrub email addresses"
              description="Emails in console, network and error text are replaced before they leave the browser."
            >
              <Loaded value={privacy} kind="switch">
                {(current) => (
                  <Switch
                    label="Scrub email addresses"
                    checked={current.scrubEmails ?? true}
                    onChange={(scrubEmails) => save({ scrubEmails })}
                  />
                )}
              </Loaded>
            </SettingRow>
            <SettingRow
              title="Scrub phone numbers"
              description="Phone numbers in console, network and error text are replaced the same way."
            >
              <Loaded value={privacy} kind="switch">
                {(current) => (
                  <Switch
                    label="Scrub phone numbers"
                    checked={current.scrubPhones ?? true}
                    onChange={(scrubPhones) => save({ scrubPhones })}
                  />
                )}
              </Loaded>
            </SettingRow>
            <SettingRow
              title="Respect Do Not Track"
              description="Visitors whose browser sends Do Not Track are not recorded."
            >
              <Loaded value={privacy} kind="switch">
                {(current) => (
                  <Switch
                    label="Respect Do Not Track"
                    checked={current.respectDnt}
                    onChange={(respectDnt) => save({ respectDnt })}
                  />
                )}
              </Loaded>
            </SettingRow>
            <SettingRow
              title="Require consent"
              description={
                <>
                  Nothing is recorded until your site calls{' '}
                  <code className="font-mono text-mono text-fg-muted">kimmi.optIn()</code>.
                </>
              }
            >
              <Loaded value={privacy} kind="switch">
                {(current) => (
                  <Switch
                    label="Require consent"
                    checked={current.requireConsent}
                    onChange={(requireConsent) => save({ requireConsent })}
                  />
                )}
              </Loaded>
            </SettingRow>
          </SettingSection>
        </>
      )}
    </Page>
  );
}
