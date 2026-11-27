import { SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useRunCleanup, useStorage } from '@/api/settings';
import type { StorageReport } from '@/api/types';
import { bytes, compact, PLATFORM_COLOR } from '@/lib/format';
import { ProjectTile } from '@/shell/AppFrame';
import {
  Button,
  Dialog,
  LinkButton,
  Page,
  SettingSection,
  SettingsEmpty,
  SettingsHeader,
  SettingsListItem,
  toast,
} from '@/ui';
import { failed, InlineError, Skeleton, SkeletonItems } from './parts';

const CHART_HEIGHT = 168;

function retentionSummary(report: StorageReport) {
  const days = report.projects.map((entry) => entry.retentionDays);
  const shortest = Math.min(...days);
  const longest = Math.max(...days);
  const kept =
    shortest === longest
      ? `Recordings are kept ${shortest} days.`
      : `Recordings are kept ${shortest} to ${longest} days depending on the project.`;
  return `${kept} The next cleanup frees ${bytes(report.nextCleanupFreesBytes)}.`;
}

function Used({ report }: { report: StorageReport }) {
  const stored = report.projects.filter((entry) => entry.bytes > 0);
  const total = Math.max(1, report.totalBytes);
  return (
    <div className="space-y-4 px-5 py-4">
      <p className="tabular text-numeric-lg text-fg">{bytes(report.totalBytes)}</p>
      <div
        role="img"
        aria-label={stored.map((entry) => `${entry.name} ${bytes(entry.bytes)}`).join(', ') || 'Nothing stored'}
        className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-chip"
      >
        {stored.map((entry) => (
          <div
            key={entry.id}
            style={{
              width: `${(entry.bytes / total) * 100}%`,
              backgroundColor: PLATFORM_COLOR[entry.platform],
            }}
          />
        ))}
      </div>
      {stored.length === 0 ? (
        <p className="text-meta text-fg-meta">No recordings stored yet.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {stored.map((entry) => (
            <div key={entry.id} className="flex gap-2">
              <span
                aria-hidden="true"
                className="mt-1.5 size-2.5 shrink-0 rounded-xs"
                style={{ backgroundColor: PLATFORM_COLOR[entry.platform] }}
              />
              <div className="min-w-0">
                <dt className="truncate text-meta text-fg-muted">{entry.name}</dt>
                <dd className="tabular text-value font-medium text-fg">{bytes(entry.bytes)}</dd>
                <dd className="tabular text-hint text-fg-meta">
                  {compact(entry.recordings)} recordings
                </dd>
              </div>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function Ages({ ages }: { ages: StorageReport['ages'] }) {
  const largest = Math.max(1, ...ages.map((bucket) => bucket.bytes));
  return (
    <div className="px-5 py-4">
      <div className="flex items-end gap-3 sm:gap-6" aria-hidden="true">
        {ages.map((bucket) => {
          const height = Math.max(2, Math.round((bucket.bytes / largest) * CHART_HEIGHT));
          const goes =
            bucket.bytes > 0
              ? Math.round((Math.min(bucket.expiringBytes, bucket.bytes) / bucket.bytes) * height)
              : 0;
          return (
            <div key={bucket.label} className="flex min-w-0 flex-1 flex-col items-center gap-2">
              <span className="tabular text-hint text-fg-meta">{bytes(bucket.bytes)}</span>
              <div
                className="flex w-full max-w-14 flex-col overflow-hidden rounded-[3px]"
                style={{ height }}
              >
                {goes > 0 ? <div className="hatch shrink-0 bg-chip" style={{ height: goes }} /> : null}
                <div className="flex-1 bg-brand" />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-3 border-t border-line-subtle pt-2 sm:gap-6" aria-hidden="true">
        {ages.map((bucket) => (
          <span key={bucket.label} className="min-w-0 flex-1 truncate text-center text-hint text-fg-meta">
            {bucket.label}
          </span>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-hint text-fg-meta">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-xs bg-brand" />
          Kept
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="hatch size-2.5 rounded-xs bg-chip" />
          Removed by the next cleanup
        </span>
      </div>
      <table className="sr-only">
        <caption>Age of the data</caption>
        <thead>
          <tr>
            <th>Age</th>
            <th>Stored</th>
            <th>Removed by the next cleanup</th>
          </tr>
        </thead>
        <tbody>
          {ages.map((bucket) => (
            <tr key={bucket.label}>
              <td>{bucket.label}</td>
              <td>{bytes(bucket.bytes)}</td>
              <td>{bytes(bucket.expiringBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Storage() {
  const storage = useStorage();
  const cleanup = useRunCleanup();
  const [cleaning, setCleaning] = useState(false);
  const report = storage.data;
  const first = report?.projects[0];
  const frees = report?.nextCleanupFreesBytes ?? 0;
  const retry = () => void storage.refetch();

  const runCleanup = () =>
    cleanup.mutate(undefined, {
      onSuccess: ({ freedBytes, deleted }) => {
        setCleaning(false);
        toast(`Freed ${bytes(freedBytes)} · ${compact(deleted)} recordings deleted`);
      },
      onError: failed,
    });

  return (
    <Page>
      <SettingsHeader
        title="Storage"
        description="How much room recordings take, how old they are and when they are deleted."
        actions={
          <>
            <Button
              variant="danger"
              icon={Trash2}
              disabled={!report}
              onClick={() => setCleaning(true)}
            >
              Run cleanup now
            </Button>
            {first ? (
              <LinkButton
                to={`/projects/${first.id}/settings/retention`}
                variant="primary"
                icon={SlidersHorizontal}
              >
                Configure retention
              </LinkButton>
            ) : null}
          </>
        }
      />

      <SettingSection title="Storage used">
        {report ? (
          <Used report={report} />
        ) : storage.isError ? (
          <InlineError error={storage.error} onRetry={retry} />
        ) : (
          <div className="space-y-4 px-5 py-4" aria-busy="true">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-3 w-full rounded-full" />
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {['a', 'b', 'c', 'd'].map((slot) => (
                <Skeleton key={slot} className="h-[60px]" />
              ))}
            </div>
          </div>
        )}
      </SettingSection>

      <SettingSection title="Retention">
        {report ? (
          report.projects.length === 0 ? (
            <SettingsEmpty title="No projects" description="Create a project to start recording." />
          ) : (
            <>
              <p className="border-b border-line-subtle px-5 py-4 text-value text-fg-muted">
                {retentionSummary(report)}
              </p>
              {report.projects.map((entry) => (
                <SettingsListItem
                  key={entry.id}
                  leading={<ProjectTile project={entry} size={24} />}
                  title={entry.name}
                  description={`Kept ${entry.retentionDays} days`}
                  meta={<span className="tabular">{bytes(entry.bytes)}</span>}
                  actions={
                    <LinkButton to={`/projects/${entry.id}/settings/retention`} size="sm">
                      Change
                    </LinkButton>
                  }
                />
              ))}
            </>
          )
        ) : storage.isError ? (
          <InlineError error={storage.error} onRetry={retry} />
        ) : (
          <SkeletonItems count={3} />
        )}
      </SettingSection>

      <SettingSection
        title="Age of the data"
        description="What is stored by how long ago it was recorded"
      >
        {report ? (
          <Ages ages={report.ages} />
        ) : storage.isError ? (
          <InlineError error={storage.error} onRetry={retry} />
        ) : (
          <div className="px-5 py-4" aria-busy="true">
            <Skeleton className="h-[254px] w-full" />
          </div>
        )}
      </SettingSection>

      <Dialog
        open={cleaning}
        onOpenChange={setCleaning}
        title="Run cleanup now"
        description="Deletes recordings past their project's retention without waiting for the nightly cleanup."
        footer={
          <>
            <Button onClick={() => setCleaning(false)}>Cancel</Button>
            <Button variant="danger" disabled={cleanup.isPending} onClick={runCleanup}>
              {frees > 0 ? `Delete ${bytes(frees)}` : 'Run cleanup'}
            </Button>
          </>
        }
      >
        <p className="text-hint text-danger-fg">Deleted recordings cannot be restored.</p>
      </Dialog>
    </Page>
  );
}
