import { type Preferences as Prefs, usePreferences, useSavePreferences } from '@/api/settings';
import { setTheme, type Theme, useTheme } from '@/shell/theme';
import {
  type Option,
  Page,
  Segmented,
  Select,
  SettingRow,
  SettingSection,
  SettingsHeader,
  Switch,
  toast,
} from '@/ui';
import { failed, Loaded, SectionError, withValue } from './parts';

const TIME_ZONES: Option[] = [
  { value: 'browser', label: 'Browser time zone' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Africa/Lagos', label: 'Lagos (UTC+1)' },
  { value: 'Europe/London', label: 'London (UTC+0)' },
  { value: 'Europe/Berlin', label: 'Berlin (UTC+1)' },
  { value: 'America/New_York', label: 'New York (UTC-5)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (UTC-8)' },
  { value: 'Asia/Kolkata', label: 'Kolkata (UTC+5:30)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (UTC+9)' },
];

const THEMES: Option<Theme>[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

type Speed = `${Prefs['playerSpeed']}`;

const SPEEDS: Option<Speed>[] = [
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
  { value: '4', label: '4×' },
];

export function Preferences() {
  const theme = useTheme();
  const preferences = usePreferences();
  const savePreferences = useSavePreferences();
  const prefs = preferences.data;

  /** Every control here applies as soon as it changes. */
  const save = (patch: Partial<Prefs>) => {
    if (!prefs) return;
    savePreferences.mutate({ ...prefs, ...patch }, { onSuccess: () => toast('Saved'), onError: failed });
  };

  const display = (
    <SettingSection title="Display" description="The look of the app in this browser">
      <SettingRow title="Theme" description="Applies right away.">
        <Segmented
          label="Theme"
          value={theme}
          onChange={(next) => {
            setTheme(next);
            toast('Saved');
          }}
          options={THEMES}
        />
      </SettingRow>
    </SettingSection>
  );

  return (
    <Page>
      <SettingsHeader
        title="Preferences"
        description="How kimmi looks and behaves for you. Nobody else is affected."
      />

      {preferences.isError ? (
        <>
          <SectionError
            title="Language and region"
            description="How dates and times are shown"
            error={preferences.error}
            onRetry={() => void preferences.refetch()}
          />
          {display}
        </>
      ) : (
        <>
          <SettingSection title="Language and region" description="How dates and times are shown">
            <SettingRow title="Time zone" description="Recording times are shown in this zone.">
              <Loaded value={prefs}>
                {(current) => (
                  <Select
                    block
                    label="Time zone"
                    value={current.timezone}
                    onChange={(timezone) => save({ timezone })}
                    options={withValue(TIME_ZONES, current.timezone, current.timezone)}
                  />
                )}
              </Loaded>
            </SettingRow>
            <SettingRow title="24-hour clock" description="Show 14:32 instead of 2:32 PM.">
              <Loaded value={prefs} kind="switch">
                {(current) => (
                  <Switch
                    label="24-hour clock"
                    checked={current.clock24}
                    onChange={(clock24) => save({ clock24 })}
                  />
                )}
              </Loaded>
            </SettingRow>
          </SettingSection>

          {display}

          <SettingSection title="Player" description="Defaults for every recording you open">
            <SettingRow title="Default speed" description="You can still change it while watching.">
              <Loaded value={prefs}>
                {(current) => (
                  <Select
                    block
                    label="Default speed"
                    value={String(current.playerSpeed) as Speed}
                    onChange={(next) => save({ playerSpeed: Number(next) as Prefs['playerSpeed'] })}
                    options={SPEEDS}
                  />
                )}
              </Loaded>
            </SettingRow>
            <SettingRow title="Skip inactivity" description="Jump over stretches where nothing happens.">
              <Loaded value={prefs} kind="switch">
                {(current) => (
                  <Switch
                    label="Skip inactivity"
                    checked={current.skipInactivity}
                    onChange={(skipInactivity) => save({ skipInactivity })}
                  />
                )}
              </Loaded>
            </SettingRow>
            <SettingRow
              title="Autoplay next recording"
              description="Start the next one in the list when a recording ends."
            >
              <Loaded value={prefs} kind="switch">
                {(current) => (
                  <Switch
                    label="Autoplay next recording"
                    checked={current.autoplayNext}
                    onChange={(autoplayNext) => save({ autoplayNext })}
                  />
                )}
              </Loaded>
            </SettingRow>
            <SettingRow title="Mouse trail" description="Draw the path of the pointer during playback.">
              <Loaded value={prefs} kind="switch">
                {(current) => (
                  <Switch
                    label="Mouse trail"
                    checked={current.mouseTrail}
                    onChange={(mouseTrail) => save({ mouseTrail })}
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
