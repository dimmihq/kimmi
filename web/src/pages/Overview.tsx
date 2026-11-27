import { CalendarDays, Flame, PlayCircle, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DEFAULT_RECORDING_FILTERS,
  useOverview,
  useRecordings,
  visitorLabel,
} from '@/api/app';
import type { Project, Recording } from '@/api/types';
import { ago, bytes, compact, duration, flag } from '@/lib/format';
import { ProjectTile, useProjectScope } from '@/shell/AppFrame';
import { ErrorNote, Skeleton, SkeletonRows } from '@/shell/states';
import {
  Avatar,
  Bars,
  cn,
  EmptyState,
  Figure,
  LinkButton,
  Page,
  Panel,
  PanelHeader,
  Segmented,
  Select,
  Tag,
  Tooltip,
} from '@/ui';

type Range = '7' | '14' | '30';
type Watch = 'latest' | 'rage' | 'errors';

interface Day {
  label: string;
  clean: number;
  friction: number;
  errors: number;
}

function VolumeChart({ days }: { days: Day[] }) {
  const max = Math.max(1, ...days.map((day) => day.clean + day.friction + day.errors));
  const ticks = [1, 0.5, 0];
  return (
    <div className="px-4 pb-4">
      <div className="flex gap-3">
        <div className="flex h-56 flex-col justify-between py-0 text-right font-mono text-[0.65rem] text-fg-ghost">
          {ticks.map((tick) => (
            <span key={tick} className="tabular -translate-y-1/2 first:translate-y-0 last:translate-y-0">
              {compact(Math.round(max * tick))}
            </span>
          ))}
        </div>
        <div className="relative h-56 flex-1">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute inset-x-0 border-t border-dashed border-line-subtle"
              style={{ top: `${(1 - tick) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 flex items-end gap-[3px]">
            {days.map((day) => {
              const total = day.clean + day.friction + day.errors;
              return (
                <Tooltip
                  key={day.label}
                  label={
                    <span className="block text-left">
                      <span className="block font-semibold">{day.label}</span>
                      <span className="tabular block opacity-80">
                        {compact(total)} recordings · {compact(day.friction)} with friction ·{' '}
                        {compact(day.errors)} with errors
                      </span>
                    </span>
                  }
                >
                  <div
                    className="flex flex-1 flex-col-reverse overflow-hidden rounded-t-[2px] transition-opacity hover:opacity-80"
                    style={{ height: `${(total / max) * 100}%` }}
                  >
                    <span className="bg-brand" style={{ flexGrow: day.clean }} />
                    <span className="bg-warning" style={{ flexGrow: day.friction }} />
                    <span className="bg-danger" style={{ flexGrow: day.errors }} />
                  </div>
                </Tooltip>
              );
            })}
          </div>
        </div>
      </div>
      <div className="mt-2 flex justify-between pl-9 font-mono text-[0.65rem] text-fg-ghost">
        <span>{days[0]?.label}</span>
        <span>{days[Math.floor(days.length / 2)]?.label}</span>
        <span>{days[days.length - 1]?.label}</span>
      </div>
      <div className="mt-3 flex gap-4 pl-9 text-hint text-fg-muted">
        {[
          ['bg-brand', 'Smooth'],
          ['bg-warning', 'Rage or dead clicks'],
          ['bg-danger', 'Errors'],
        ].map(([color, label]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className={cn('size-2 rounded-[2px]', color)} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

const WATCH_EMPTY: Record<Watch, string> = {
  latest: 'No recordings yet.',
  rage: 'No recent recording has rage clicks.',
  errors: 'No recent recording has errors.',
};

/** "2026-11-27" as "27 Nov", in the viewer's locale. */
const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const percent = (part: number, whole: number) =>
  `${whole > 0 ? ((part / whole) * 100).toFixed(1) : '0.0'}%`;

function WatchRow({ entry, base }: { entry: Recording; base: string }) {
  const who = entry.visitor;
  const tone = entry.errors > 0 ? 'bg-danger' : entry.rageClicks > 0 ? 'bg-warning' : 'bg-bar-muted';
  return (
    <Link
      to={`${base}/recordings/${entry.id}`}
      className="group flex items-center gap-3 border-t border-line-subtle px-4 py-2.5 transition-colors duration-75 hover:bg-hover"
    >
      <span className={cn('h-8 w-[3px] shrink-0 rounded-full', tone)} />
      <Avatar name={visitorLabel(who)} />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-control text-fg', !who.name && 'font-mono text-mono')}>
          {visitorLabel(who)}
        </span>
        <span className="block truncate font-mono text-[0.68rem] text-fg-meta">
          {entry.entry} → {entry.exit}
        </span>
      </span>
      <span className="hidden items-center gap-1 sm:flex">
        {entry.rageClicks > 0 ? (
          <Tag tone="warning" icon={Flame}>
            {entry.rageClicks}
          </Tag>
        ) : null}
        {entry.errors > 0 ? (
          <Tag tone="danger" icon={TriangleAlert}>
            {entry.errors}
          </Tag>
        ) : null}
      </span>
      <span className="w-16 shrink-0 text-right">
        <span className="tabular block font-mono text-mono text-fg-secondary">
          {duration(entry.durationMs)}
        </span>
        <span className="tabular block text-hint text-fg-meta">
          {entry.live ? 'live' : ago(entry.startedAt)}
        </span>
      </span>
    </Link>
  );
}

function Share({
  label,
  value,
  share,
  detail,
  mono,
}: {
  label: string;
  value: string;
  share: number;
  detail?: string;
  mono?: boolean;
}) {
  return (
    <div className="relative flex items-center gap-3 px-4 py-2">
      <span
        className="absolute inset-y-1 left-2 rounded-md bg-selected"
        style={{ width: `calc(${share * 100}% - 16px)` }}
      />
      <span className={cn('relative min-w-0 flex-1 truncate text-control text-fg-secondary', mono && 'font-mono text-mono')}>
        {label}
      </span>
      {detail ? <span className="relative text-hint text-warning-fg">{detail}</span> : null}
      <span className="tabular relative w-12 text-right text-control text-fg">{value}</span>
    </div>
  );
}

function FigureSkeleton() {
  return (
    <Panel className="flex min-h-[104px] flex-col px-4 py-3.5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-6 w-20" />
      <Skeleton className="mt-2.5 h-3 w-28" />
    </Panel>
  );
}

function ShareSkeleton({ rows }: { rows: number }) {
  return (
    <div aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
        <div key={index} className="flex items-center gap-3 px-4 py-2">
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-8" />
        </div>
      ))}
    </div>
  );
}

function WorthWatching({ current, base }: { current: Project; base: string }) {
  const [watch, setWatch] = useState<Watch>('latest');
  const list = useRecordings(current.id, {
    ...DEFAULT_RECORDING_FILTERS,
    rage: watch === 'rage',
    errors: watch === 'errors',
    limit: 6,
  });
  const items = list.data?.items;
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Worth watching"
        description="Where to look first"
        action={
          <Segmented
            label="Which recordings"
            value={watch}
            onChange={setWatch}
            options={[
              { value: 'latest', label: 'Latest' },
              { value: 'rage', label: 'Rage clicks' },
              { value: 'errors', label: 'Errors' },
            ]}
          />
        }
      />
      {list.isPending ? (
        <div className="border-t border-line-subtle">
          <SkeletonRows count={6} />
        </div>
      ) : !items ? (
        <ErrorNote
          className="border-t border-line-subtle"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : items.length === 0 ? (
        <p className="border-t border-line-subtle px-4 py-10 text-center text-body text-fg-meta">
          {WATCH_EMPTY[watch]}
        </p>
      ) : (
        items.map((entry) => <WatchRow key={entry.id} entry={entry} base={base} />)
      )}
      <Link
        to={`${base}/recordings`}
        className="flex h-10 items-center justify-center border-t border-line-subtle text-control text-fg-muted hover:bg-hover hover:text-fg"
      >
        See all recordings
      </Link>
    </Panel>
  );
}

export function Overview() {
  const current = useProjectScope();
  const base = `/projects/${current.id}`;
  const [range, setRange] = useState<Range>('14');
  const overview = useOverview(current.id, Number(range));
  const data = overview.data;

  const days = useMemo<Day[]>(
    () =>
      (data?.days ?? []).map((day) => ({
        label: dayLabel(day.date),
        clean: day.clean,
        friction: day.friction,
        errors: day.errors,
      })),
    [data],
  );

  if (current.stats.recordings === 0) {
    return (
      <Page>
        <header className="mb-6 flex items-center gap-3">
          <ProjectTile project={current} size={36} />
          <div>
            <h1 className="text-page-title text-fg">{current.name}</h1>
            <p className="font-mono text-mono text-fg-meta">{current.slug}</p>
          </div>
        </header>
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState
            icon={PlayCircle}
            title="Waiting for the first recording"
            description="Add the snippet to your site. Sessions appear here a few seconds after someone visits."
            action={
              <LinkButton to={`${base}/settings/install`} variant="primary">
                Install kimmi
              </LinkButton>
            }
          />
        </div>
      </Page>
    );
  }

  const totals = data?.totals;
  const devices = data?.devices.slice(0, 5) ?? [];
  const countries = data?.countries.slice(0, 5) ?? [];
  const pages = data?.topPages.slice(0, 7) ?? [];
  const topViews = Math.max(1, pages[0]?.views ?? 0);
  const trend = totals?.trendPercent ?? 0;

  return (
    <Page>
      <header className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <ProjectTile project={current} size={36} />
        <div className="min-w-0 flex-1">
          <h1 className="text-page-title text-fg">{current.name}</h1>
          <p className="mt-0.5 text-hint text-fg-meta">
            <span className="font-mono">{current.slug}</span> · {bytes(current.stats.storageBytes)}{' '}
            stored · kept {current.retentionDays} days
          </p>
        </div>
        <Tag tone="brand" dot>
          {current.stats.live} live now
        </Tag>
        <Select
          label="Time range"
          value={range}
          onChange={setRange}
          icon={CalendarDays}
          className="w-28"
          options={[
            { value: '7', label: '7 days' },
            { value: '14', label: '14 days' },
            { value: '30', label: '30 days' },
          ]}
        />
      </header>

      {overview.isPending ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <FigureSkeleton />
            <FigureSkeleton />
            <FigureSkeleton />
            <FigureSkeleton />
          </div>
          <Panel className="mt-3">
            <PanelHeader title="Recordings over time" description={<Skeleton className="mt-1 h-3 w-40" />} />
            <div className="px-4 pb-4">
              <Skeleton className="h-56 w-full" />
              <Skeleton className="mt-3 h-3 w-64" />
            </div>
          </Panel>
        </>
      ) : !totals ? (
        <Panel>
          <ErrorNote error={overview.error} onRetry={() => void overview.refetch()} />
        </Panel>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Figure
              label="Recordings"
              value={compact(totals.recordings)}
              delta={`${trend > 0 ? '+' : ''}${trend.toFixed(1)}%`}
              deltaTone={trend >= 0 ? 'good' : 'bad'}
              detail={`${compact(totals.today)} today`}
            >
              <Bars values={days.map((day) => day.clean + day.friction + day.errors)} />
            </Figure>
            <Figure
              label="Average duration"
              value={duration(totals.avgDurationMs)}
              detail={`${duration(totals.avgActiveMs)} active`}
            />
            <Figure
              label="Sessions with friction"
              value={percent(totals.frictionSessions, totals.recordings)}
              detail={`${compact(totals.frictionSessions)} with rage or dead clicks`}
            >
              <Bars values={days.map((day) => day.friction)} tone="muted" />
            </Figure>
            <Figure
              label="Sessions with errors"
              value={percent(totals.errorSessions, totals.recordings)}
              detail={`${compact(totals.errorSessions)} sessions`}
            >
              <Bars values={days.map((day) => day.errors)} tone="danger" />
            </Figure>
          </div>

          <Panel className="mt-3">
            <PanelHeader
              title="Recordings over time"
              description={`${compact(totals.recordings)} sessions in this window`}
            />
            <VolumeChart days={days} />
          </Panel>
        </>
      )}

      <div className="mt-3 grid gap-3 xl:grid-cols-[1.5fr_1fr]">
        <WorthWatching current={current} base={base} />

        <div className="grid content-start gap-3">
          <Panel className="pb-2">
            <PanelHeader title="Top pages" description="Page views and rage clicks in recordings" />
            {data ? (
              pages.map((page) => (
                <Share
                  key={page.path}
                  label={page.path}
                  mono
                  share={page.views / topViews}
                  value={compact(page.views)}
                  detail={page.rage > 0 ? `${page.rage} rage` : undefined}
                />
              ))
            ) : (
              <ShareSkeleton rows={overview.isPending ? 7 : 0} />
            )}
          </Panel>
          <Panel className="grid grid-cols-2 pb-2">
            <div>
              <PanelHeader title="Devices" />
              {data ? (
                devices.map((entry) => (
                  <Share
                    key={entry.name}
                    label={entry.name}
                    share={entry.count / Math.max(1, devices[0].count)}
                    value={`${Math.round((entry.count / Math.max(1, data.totals.recordings)) * 100)}%`}
                  />
                ))
              ) : (
                <ShareSkeleton rows={overview.isPending ? 3 : 0} />
              )}
            </div>
            <div className="border-l border-line-subtle">
              <PanelHeader title="Countries" />
              {data ? (
                countries.map((entry) => (
                  <Share
                    key={entry.code}
                    label={`${flag(entry.code)} ${entry.name}`}
                    share={entry.count / Math.max(1, countries[0].count)}
                    value={`${Math.round((entry.count / Math.max(1, data.totals.recordings)) * 100)}%`}
                  />
                ))
              ) : (
                <ShareSkeleton rows={overview.isPending ? 3 : 0} />
              )}
            </div>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
