import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Flame,
  Monitor,
  PlayCircle,
  Search,
  Smartphone,
  Tablet,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  DEFAULT_RECORDING_FILTERS,
  type DeviceFilter,
  type DurationFilter,
  type RecordingFilters,
  type RecordingView,
  useRecordings,
  visitorLabel,
} from '@/api/app';
import { ago, compact, duration } from '@/lib/format';
import { useProjectScope } from '@/shell/AppFrame';
import { ErrorNote, SkeletonRows } from '@/shell/states';
import {
  Avatar,
  cn,
  EmptyState,
  IconButton,
  Input,
  LinkButton,
  Page,
  PageHeader,
  Select,
  Tabs,
  Tag,
  Tooltip,
} from '@/ui';

const DEVICE_ICON = { Desktop: Monitor, Mobile: Smartphone, Tablet };
const PER_PAGE = DEFAULT_RECORDING_FILTERS.limit;

const VIEWS: RecordingView[] = ['all', 'unwatched', 'friction', 'starred'];
const DURATIONS: DurationFilter[] = ['any', 'short', 'medium', 'long'];
const DEVICES: DeviceFilter[] = ['any', 'Desktop', 'Mobile', 'Tablet'];

const oneOf = <T extends string>(options: readonly T[], value: string | null, fallback: T) =>
  options.find((option) => option === value) ?? fallback;

const parseFilters = (params: URLSearchParams): RecordingFilters => ({
  view: oneOf(VIEWS, params.get('view'), 'all'),
  q: params.get('q') ?? '',
  duration: oneOf(DURATIONS, params.get('duration'), 'any'),
  device: oneOf(DEVICES, params.get('device'), 'any'),
  rage: params.get('rage') === '1',
  errors: params.get('errors') === '1',
  page: Math.max(0, Number.parseInt(params.get('page') ?? '0', 10) || 0),
  limit: PER_PAGE,
});

/**
 * The filters live in the query string, so a reload or a shared link keeps
 * them. Changing any filter but the page goes back to the first page.
 */
function useFilterParams() {
  const [params, setParams] = useSearchParams();
  const update = useCallback(
    (next: Partial<RecordingFilters>) =>
      setParams(
        (current) => {
          const merged = { ...parseFilters(current), page: 0, ...next };
          const out = new URLSearchParams(current);
          for (const key of ['view', 'q', 'duration', 'device', 'rage', 'errors', 'page'] as const) {
            const value = merged[key];
            if (value === DEFAULT_RECORDING_FILTERS[key]) out.delete(key);
          else out.set(key, typeof value === 'boolean' ? '1' : String(value));
          }
          return out;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [parseFilters(params), update] as const;
}

function Toggle({
  on,
  onChange,
  icon: Icon,
  children,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  icon: typeof Flame;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-control transition-colors duration-100',
        on
          ? 'border-brand bg-brand-soft text-fg'
          : 'border-line-field bg-hover text-fg-muted hover:bg-active hover:text-fg',
      )}
    >
      <Icon className="size-3.5" />
      {children}
    </button>
  );
}

export function Recordings() {
  const current = useProjectScope();
  const [filters, update] = useFilterParams();
  const list = useRecordings(current.id, filters, { refetchInterval: 10_000 });
  const data = list.data;
  const host = current.origin.replace(/^https?:\/\//, '');

  // The search box answers at once; the URL and the request follow 300 ms later.
  const [draft, setDraft] = useState(filters.q);
  const [lastQ, setLastQ] = useState(filters.q);
  if (lastQ !== filters.q) {
    setLastQ(filters.q);
    setDraft(filters.q);
  }
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);
  const search = (value: string) => {
    setDraft(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => update({ q: value }), 300);
  };

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const at = Math.min(filters.page, pages - 1);
  const rows = data?.items ?? [];

  if (current.stats.recordings === 0) {
    return (
      <Page>
        <PageHeader title="Recordings" description={`Sessions recorded on ${host}`} />
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState
            icon={PlayCircle}
            title="No recordings yet"
            description="Add the snippet to your site. The first session shows up here a few seconds after someone visits."
            action={
              <LinkButton to={`/projects/${current.id}/settings/install`} variant="primary">
                Install kimmi
              </LinkButton>
            }
          />
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Recordings"
        description={`Sessions recorded on ${host} · ${compact(current.stats.recordings24h)} in the last 24 h`}
      />

      <Tabs
        label="Recording views"
        value={filters.view}
        onChange={(view) => update({ view })}
        options={[
          { value: 'all', label: 'All', count: data?.counts.all },
          { value: 'unwatched', label: 'Unwatched', count: data?.counts.unwatched },
          { value: 'friction', label: 'With friction', count: data?.counts.friction },
          { value: 'starred', label: 'Starred', count: data?.counts.starred },
        ]}
      />

      <div className="my-4 flex flex-wrap gap-2">
        <div className="min-w-56 flex-1">
          <Input
            icon={Search}
            placeholder="Filter by visitor, place or page"
            value={draft}
            onChange={(event) => search(event.target.value)}
            className="h-9"
          />
        </div>
        <Select
          label="Duration"
          value={filters.duration}
          onChange={(duration) => update({ duration })}
          icon={Clock}
          className="h-9 w-40"
          options={[
            { value: 'any', label: 'Any duration' },
            { value: 'short', label: 'Under 1 min' },
            { value: 'medium', label: '1 to 5 min' },
            { value: 'long', label: 'Over 5 min' },
          ]}
        />
        <Select
          label="Device"
          value={filters.device}
          onChange={(device) => update({ device })}
          icon={Monitor}
          className="h-9 w-36"
          options={[
            { value: 'any', label: 'Any device' },
            { value: 'Desktop', label: 'Desktop' },
            { value: 'Mobile', label: 'Mobile' },
            { value: 'Tablet', label: 'Tablet' },
          ]}
        />
        <Toggle on={filters.rage} onChange={(rage) => update({ rage })} icon={Flame}>
          Rage clicks
        </Toggle>
        <Toggle on={filters.errors} onChange={(errors) => update({ errors })} icon={TriangleAlert}>
          Errors
        </Toggle>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex h-[38px] items-center gap-6 border-b border-line-subtle px-4 text-label text-fg-meta">
          <span className="min-w-0 flex-[1.2]">Visitor</span>
          <span className="hidden w-44 shrink-0 md:block">Device</span>
          <span className="hidden min-w-0 flex-[1.4] lg:block">Entry page</span>
          <span className="w-16 shrink-0 text-right">Duration</span>
          <span className="hidden w-24 shrink-0 sm:block">Signals</span>
          <span className="w-20 shrink-0 text-right">Started</span>
        </div>

        {list.isPending ? (
          <SkeletonRows count={8} />
        ) : !data ? (
          <ErrorNote error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No recording matches"
            description="Loosen a filter or clear the search to see more sessions."
          />
        ) : (
          rows.map((entry) => {
            const who = entry.visitor;
            const DeviceIcon = DEVICE_ICON[who.device];
            return (
              <Link
                key={entry.id}
                to={`/projects/${current.id}/recordings/${entry.id}`}
                className="flex h-12 items-center gap-6 border-b border-line-subtle px-4 transition-colors duration-75 last:border-b-0 hover:bg-hover"
              >
                <span className="flex min-w-0 flex-[1.2] items-center gap-3">
                  <Avatar name={visitorLabel(who)} />
                  <span className="min-w-0">
                    <span
                      className={cn(
                        'block truncate text-control',
                        entry.seen ? 'text-fg-secondary' : 'font-semibold text-fg',
                      )}
                    >
                      {who.name ?? 'Anonymous visitor'}
                    </span>
                    <span className="block truncate text-hint text-fg-meta">
                      {who.city}, {who.country}
                    </span>
                  </span>
                </span>

                <span className="hidden w-44 shrink-0 items-center gap-2 truncate text-control text-fg-muted md:flex">
                  <DeviceIcon className="size-3.5 shrink-0 text-fg-ghost" />
                  <span className="truncate">{who.browser}</span>
                </span>

                <span className="hidden min-w-0 flex-[1.4] truncate font-mono text-mono text-fg-muted lg:block">
                  {entry.entry}
                </span>

                <span className="tabular w-16 shrink-0 text-right font-mono text-mono text-fg-secondary">
                  {duration(entry.durationMs)}
                </span>

                <span className="hidden w-24 shrink-0 items-center gap-1 sm:flex">
                  {entry.rageClicks > 0 ? (
                    <Tooltip label={`${entry.rageClicks} rage clicks`}>
                      <span>
                        <Tag tone="warning" icon={Flame}>
                          {entry.rageClicks}
                        </Tag>
                      </span>
                    </Tooltip>
                  ) : null}
                  {entry.errors > 0 ? (
                    <Tooltip label={`${entry.errors} errors`}>
                      <span>
                        <Tag tone="danger" icon={TriangleAlert}>
                          {entry.errors}
                        </Tag>
                      </span>
                    </Tooltip>
                  ) : null}
                </span>

                <span className="tabular w-20 shrink-0 text-right text-control text-fg-meta">
                  {entry.live ? (
                    <Tag tone="brand" dot>
                      Live
                    </Tag>
                  ) : (
                    ago(entry.lastAt)
                  )}
                </span>
              </Link>
            );
          })
        )}

        <div className="flex h-11 items-center justify-between border-t border-line-subtle px-4 text-control text-fg-meta">
          <span className="tabular">
            {total === 0
              ? '0 recordings'
              : `${at * PER_PAGE + 1}–${Math.min(total, (at + 1) * PER_PAGE)} of ${total}`}
          </span>
          <span className="flex items-center gap-1">
            <IconButton
              icon={ChevronLeft}
              label="Previous page"
              disabled={at === 0}
              onClick={() => update({ page: at - 1 })}
            />
            <span className="tabular px-1">
              {at + 1} / {pages}
            </span>
            <IconButton
              icon={ChevronRight}
              label="Next page"
              disabled={at >= pages - 1}
              onClick={() => update({ page: at + 1 })}
            />
          </span>
        </div>
      </div>
    </Page>
  );
}
