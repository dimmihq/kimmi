import { Copy, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useInstance } from '@/api/settings';
import type { Instance as InstanceInfo } from '@/api/types';
import { ago } from '@/lib/format';
import {
  Button,
  IconButton,
  Page,
  SettingRow,
  SettingSection,
  SettingsHeader,
  Tag,
  toast,
} from '@/ui';
import { ControlSkeleton, InlineError, Loaded, Skeleton } from './parts';

const DATABASE: Record<string, string> = { postgres: 'PostgreSQL', sqlite: 'SQLite' };
const STORAGE: Record<string, string> = { s3: 'S3-compatible', local: 'Local disk' };

const STATUS: Record<
  InstanceInfo['health'][number]['status'],
  { label: string; tone: 'brand' | 'warning' | 'danger' }
> = {
  healthy: { label: 'Healthy', tone: 'brand' },
  degraded: { label: 'Degraded', tone: 'warning' },
  down: { label: 'Down', tone: 'danger' },
};

/** "12 days, 4 hours" since the server started. */
function uptime(startedAt: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60e3));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? '' : 's'}`;
  if (days > 0) return `${unit(days, 'day')}, ${unit(hours, 'hour')}`;
  if (hours > 0) return `${unit(hours, 'hour')}, ${unit(minutes % 60, 'minute')}`;
  return unit(minutes, 'minute');
}

/** A read-only value, sitting where a control would. */
function Value({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <p className={mono ? 'truncate font-mono text-mono text-fg-secondary' : 'text-value text-fg-secondary'}>
      {children}
    </p>
  );
}

export function Instance() {
  const instance = useInstance();
  const info = instance.data;

  return (
    <Page>
      <SettingsHeader
        title="Instance"
        description="What this kimmi server runs and how it is doing. Nothing here can be changed."
        actions={
          <Button icon={RefreshCw} onClick={() => toast('kimmi is up to date')}>
            Check for updates
          </Button>
        }
      />

      <SettingSection title="About" description="The kimmi build running on this server">
        {instance.isError && !info ? (
          <InlineError error={instance.error} onRetry={() => void instance.refetch()} />
        ) : (
          <>
            <SettingRow title="Version">
              <Loaded value={info}>{(entry) => <Value>{entry.version}</Value>}</Loaded>
            </SettingRow>
            <SettingRow title="Build">
              <Loaded value={info}>{(entry) => <Value mono>{entry.commit.slice(0, 7)}</Value>}</Loaded>
            </SettingRow>
            <SettingRow title="Uptime">
              <Loaded value={info}>{(entry) => <Value>{uptime(entry.startedAt)}</Value>}</Loaded>
            </SettingRow>
          </>
        )}
      </SettingSection>

      {info || !instance.isError ? (
        <>
          <SettingSection title="This server" description="How the server is set up">
            <SettingRow title="Roles" description="The jobs this process does.">
              <Loaded value={info}>
                {(entry) => (
                  <div className="flex flex-wrap gap-1.5">
                    {entry.roles.map((role) => (
                      <Tag key={role}>{role}</Tag>
                    ))}
                  </div>
                )}
              </Loaded>
            </SettingRow>
            <SettingRow title="Database">
              <Loaded value={info}>
                {(entry) => (
                  <Value>
                    {DATABASE[entry.database.driver] ?? entry.database.driver} {entry.database.version}
                  </Value>
                )}
              </Loaded>
            </SettingRow>
            <SettingRow title="Recordings stored in" description="Set in the server configuration.">
              <Loaded value={info}>
                {(entry) => (
                  <Value>
                    {STORAGE[entry.storage.driver] ?? entry.storage.driver} · {entry.storage.location}
                  </Value>
                )}
              </Loaded>
            </SettingRow>
            <SettingRow title="Instance URL" description="Where browsers send recordings.">
              <Loaded value={info}>
                {(entry) => (
                  <div className="flex items-center gap-1">
                    <Value mono>{entry.publicUrl}</Value>
                    <IconButton
                      icon={Copy}
                      label="Copy URL"
                      onClick={() => {
                        void navigator.clipboard?.writeText(entry.publicUrl);
                        toast('Copied to clipboard');
                      }}
                    />
                  </div>
                )}
              </Loaded>
            </SettingRow>
          </SettingSection>

          <SettingSection
            title="Health"
            description={info ? `Checked ${ago(instance.dataUpdatedAt)}` : 'Checking'}
          >
            {info ? (
              info.health.map((check) => (
                <SettingRow key={check.name} title={check.name}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="tabular text-value text-fg-muted">{check.detail}</span>
                    <Tag tone={STATUS[check.status].tone}>{STATUS[check.status].label}</Tag>
                  </div>
                </SettingRow>
              ))
            ) : (
              ['a', 'b'].map((slot) => (
                <SettingRow key={slot} title={<Skeleton className="my-0.5 h-4 w-24" />}>
                  <ControlSkeleton />
                </SettingRow>
              ))
            )}
          </SettingSection>
        </>
      ) : null}
    </Page>
  );
}
