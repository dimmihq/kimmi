import {
  ArrowUpDown,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flame,
  Monitor,
  PlayCircle,
  Plus,
  Search,
  Smartphone,
  Tablet,
  Trash2,
  TriangleAlert,
  X,
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
import { errorMessage } from '@/api/http';
import { type Preferences, usePreferences, useSavePreferences } from '@/api/settings';
import { ago, compact, duration } from '@/lib/format';
import { useProjectScope } from '@/shell/AppFrame';
import { ErrorNote, SkeletonRows } from '@/shell/states';
import {
  Avatar,
  Button,
  cn,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  LinkButton,
  Menu,
  type MenuAction,
  Page,
  PageHeader,
  Select,
  Tabs,
  Tag,
  toast,
  Tooltip,
} from '@/ui';

const DEVICE_ICON = { Desktop: Monitor, Mobile: Smartphone, Tablet };
const PER_PAGE = DEFAULT_RECORDING_FILTERS.limit;

const VIEWS: RecordingView[] = ['all', 'unwatched', 'friction', 'starred'];
const DURATIONS: DurationFilter[] = ['any', 'short', 'medium', 'long'];
const DEVICES: DeviceFilter[] = ['any', 'Desktop', 'Mobile', 'Tablet'];

const oneOf = <T extends string>(options: readonly T[], value: string | null, fallback: T) =>
  options.find((option) => option === value) ?? fallback;

/**
 * Filters the analytics pages link here with. They have no control in the
 * bar: each one shows as a chip that can be removed.
 */
const EXTRA_KEYS = [
  'entry',
  'exit',
  'path',
  'referrer',
  'channel',
  'utmSource',
  'utmCampaign',
  'country',
  'browser',
  'os',
  'language',
  'release',
  'event',
  'eventPath',
] as const;
type ExtraKey = (typeof EXTRA_KEYS)[number];
type Sort = 'newest' | 'score';

/** The list request: `useRecordings` sends every key of it as a query parameter. */
type ListFilters = RecordingFilters & Partial<Record<ExtraKey, string>> & { sort?: 'score' };

const EXTRA_LABEL: Record<ExtraKey, string> = {
  entry: 'Entry page',
  exit: 'Exit page',
  path: 'Page',
  referrer: 'Source',
  channel: 'Channel',
  utmSource: 'UTM source',
  utmCampaign: 'Campaign',
  country: 'Country',
  browser: 'Browser',
  os: 'OS',
  language: 'Language',
  release: 'Release',
  event: 'Event',
  eventPath: 'Event page',
};

const EVENT_LABEL: Record<string, string> = {
  error: 'Error',
  rage: 'Rage click',
  dead: 'Dead click',
  track: 'Event',
  request: 'Request',
};

/** "Entry page" and "/pricing" for `entry=/pricing`; "Error" and "3f2a91c0…" for `event=error:3f2a91c0…`. */
function chip(key: ExtraKey, value: string): [label: string, value: string] {
  if (key !== 'event') return [EXTRA_LABEL[key], value];
  const colon = value.indexOf(':');
  const label = EVENT_LABEL[value.slice(0, colon)];
  if (!label) return ['Event', value];
  const rest = value.slice(colon + 1);
  return [label, label === 'Error' && rest.length > 8 ? `${rest.slice(0, 8)}…` : rest];
}

const parseExtra = (params: URLSearchParams) => {
  const extra: Partial<Record<ExtraKey, string>> = {};
  for (const key of EXTRA_KEYS) {
    const value = params.get(key);
    if (value) extra[key] = value;
  }
  return extra;
};

interface SavedView {
  name: string;
  /** The list's query string, without the page. */
  query: string;
}

/** Preferences are stored whole and free-form; saved views live under their own key, by project. */
type ViewPreferences = Preferences & { savedViews?: Record<string, SavedView[]> };

/** The query string a view is saved and compared as. */
function viewQuery(params: URLSearchParams) {
  const out = new URLSearchParams(params);
  out.delete('page');
  out.sort();
  return out.toString();
}

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
  /** Rewrites the query string and goes back to the first page. */
  const rewrite = useCallback(
    (change: (out: URLSearchParams) => URLSearchParams | void) =>
      setParams(
        (current) => {
          const out = new URLSearchParams(current);
          out.delete('page');
          return change(out) ?? out;
        },
        { replace: true },
      ),
    [setParams],
  );
  return { params, filters: parseFilters(params), update, rewrite };
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
  const { params, filters, update, rewrite } = useFilterParams();
  const extra = parseExtra(params);
  const chips = EXTRA_KEYS.filter((key) => extra[key] !== undefined);
  const sort: Sort = params.get('sort') === 'score' ? 'score' : 'newest';
  const request: ListFilters = { ...filters, ...extra, sort: sort === 'score' ? 'score' : undefined };
  const list = useRecordings(current.id, request, { refetchInterval: 10_000 });

  const preferences = usePreferences();
  const savePreferences = useSavePreferences();
  const stored = preferences.data as ViewPreferences | undefined;
  const views = stored?.savedViews?.[current.id] ?? [];
  const here = viewQuery(params);
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState('');
  const [forgetting, setForgetting] = useState<SavedView | null>(null);

  const storeViews = (next: SavedView[], done: string) => {
    if (!stored) return;
    const all: ViewPreferences = {
      ...stored,
      savedViews: { ...stored.savedViews, [current.id]: next },
    };
    savePreferences.mutate(all, {
      onSuccess: () => toast(done),
      onError: (error) => toast(errorMessage(error)),
    });
  };
  const closeNaming = () => {
    setNaming(false);
    setViewName('');
  };
  const saveView = () => {
    const name = viewName.trim();
    if (!name || !stored) return;
    storeViews([...views.filter((view) => view.name !== name), { name, query: here }], 'View saved');
    closeNaming();
  };
  const savedActions: MenuAction[] = [
    { id: 'save', label: 'Save this view…', icon: Plus, onSelect: () => setNaming(true) },
    ...views.map((view, index) => ({
      id: `open:${view.name}`,
      label: view.name,
      separated: index === 0,
      selected: view.query === here,
      onSelect: () => rewrite(() => new URLSearchParams(view.query)),
    })),
    ...views.map((view, index) => ({
      id: `delete:${view.name}`,
      label: `Delete ${view.name}`,
      icon: Trash2,
      tone: 'danger' as const,
      separated: index === 0,
      onSelect: () => setForgetting(view),
    })),
  ];
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
        <Select
          label="Sort"
          value={sort}
          onChange={(next) =>
            rewrite((out) => {
              if (next === 'score') out.set('sort', 'score');
              else out.delete('sort');
            })
          }
          icon={ArrowUpDown}
          className="h-9 w-44"
          options={[
            { value: 'newest', label: 'Newest first' },
            { value: 'score', label: 'Worth watching' },
          ]}
        />
        <Menu
          align="end"
          actions={savedActions}
          trigger={
            <Button size="lg" icon={Bookmark} className="px-2.5">
              Saved
            </Button>
          }
        />
      </div>

      {chips.length > 0 ? (
        <div className="-mt-2 mb-4 flex flex-wrap items-center gap-1.5">
          {chips.map((key) => {
            const [label, value] = chip(key, extra[key] ?? '');
            return (
              <Tag key={key} className="max-w-full gap-0.5 pr-0">
                <span className="truncate">
                  {label}: <span className="text-fg-secondary">{value}</span>
                </span>
                <IconButton
                  icon={X}
                  label={`Remove ${label.toLowerCase()} filter`}
                  onClick={() => rewrite((out) => out.delete(key))}
                  className="size-5! rounded-[5px] [&_svg]:size-3"
                />
              </Tag>
            );
          })}
          <Button
            variant="ghost"
            size="sm"
            className="h-5! px-1.5 text-hint"
            onClick={() =>
              rewrite((out) => {
                for (const key of EXTRA_KEYS) out.delete(key);
              })
            }
          >
            Clear
          </Button>
        </div>
      ) : null}

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
                      {visitorLabel(who)}
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

      <Dialog
        open={naming}
        onOpenChange={(open) => {
          if (open) setNaming(true);
          else closeNaming();
        }}
        title="Save this view"
        description="The filters and sort as they are now, kept under a name only you see."
        footer={
          <>
            <Button onClick={closeNaming}>Cancel</Button>
            <Button
              variant="primary"
              disabled={viewName.trim().length === 0 || !stored}
              onClick={saveView}
            >
              Save view
            </Button>
          </>
        }
      >
        <Field label="Name">
          <Input
            autoFocus
            placeholder="Checkout errors on mobile"
            value={viewName}
            onChange={(event) => setViewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveView();
            }}
          />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={forgetting !== null}
        onOpenChange={(open) => {
          if (!open) setForgetting(null);
        }}
        title={forgetting ? `Delete ${forgetting.name}?` : 'Delete view?'}
        description="The saved view is removed. No recording is deleted."
        confirmLabel="Delete view"
        danger
        onConfirm={() => {
          if (!forgetting) return;
          storeViews(
            views.filter((view) => view.name !== forgetting.name),
            'View deleted',
          );
        }}
      />
    </Page>
  );
}
