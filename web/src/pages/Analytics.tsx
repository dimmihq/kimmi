import { BarChart3, CalendarDays, X } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  type Breakdown,
  type Days,
  type EventStat,
  type GoalStat,
  recordingsHref,
  type Traffic,
  useEventNames,
  useTraffic,
  type VisitFilter,
} from '@/api/analytics';
import {
  change,
  compact,
  countryName,
  duration,
  flag,
  languageName,
  rate,
  shortDay,
  signed,
} from '@/lib/format';
import { ErrorNote, Skeleton } from '@/shell/states';
import {
  Button,
  cn,
  EmptyState,
  Figure,
  LinkButton,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Segmented,
  Select,
  Tag,
} from '@/ui';
import {
  FigureSkeleton,
  Quiet,
  type Rank,
  RankRow,
  RankSkeleton,
  VisitorsChart,
} from './analytics/parts';

const WINDOWS: Days[] = [1, 7, 14, 30, 90];
const ROWS = 8;

const FILTER_LABEL: Record<keyof VisitFilter, string> = {
  path: 'Page',
  entry: 'Entry page',
  exit: 'Exit page',
  referrer: 'Source',
  channel: 'Channel',
  utmSource: 'UTM source',
  utmCampaign: 'Campaign',
  country: 'Country',
  device: 'Device',
  browser: 'Browser',
  os: 'System',
  language: 'Language',
};
const FILTER_KEYS = Object.keys(FILTER_LABEL) as (keyof VisitFilter)[];

const AUTOMATIC: Record<string, string> = {
  $outbound: 'Outbound link',
  $download: 'Download',
  $email: 'Email link',
  $phone: 'Phone link',
  $form: 'Form submitted',
};

const filterText = (key: keyof VisitFilter, value: string) =>
  key === 'country' ? countryName(value) : key === 'language' ? languageName(value) : value;

const countryLabel = (code: string) => `${flag(code)} ${countryName(code)}`.trim();

const amount = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** How the events query is doing, so its panel can stand in for it. */
export interface EventsStatus {
  pending: boolean;
  error: unknown;
  retry: () => void;
}

interface View {
  value: string;
  label: string;
  filter: keyof VisitFilter;
  rows: Rank[];
  mono?: boolean;
}

const ranks = (
  entries: Breakdown[],
  label: (name: string) => string = (name) => name || 'Unknown',
  detail?: (name: string) => ReactNode,
): Rank[] =>
  entries.map((entry) => ({
    name: entry.name,
    label: label(entry.name),
    count: entry.visitors,
    detail: detail?.(entry.name),
  }));

/** A ranked list that switches between a few views of the same question. */
function Breakdowns({
  title,
  description,
  views,
  projectId,
  filter,
  onFilter,
}: {
  title: string;
  description: string;
  views: View[];
  projectId?: string;
  filter?: VisitFilter;
  onFilter?: (patch: Partial<VisitFilter>) => void;
}) {
  const [at, setAt] = useState(views[0].value);
  const view = views.find((entry) => entry.value === at) ?? views[0];
  const rows = view.rows.slice(0, ROWS);
  const top = Math.max(1, ...rows.map((row) => row.count));
  const pick = projectId ? onFilter : undefined;
  return (
    <Panel className="pb-2">
      <PanelHeader
        title={title}
        description={description}
        action={
          views.length > 1 ? (
            <Segmented
              label={title}
              value={view.value}
              onChange={setAt}
              options={views.map((entry) => ({ value: entry.value, label: entry.label }))}
            />
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <Quiet>Nothing in this window.</Quiet>
      ) : (
        rows.map((row) => {
          const active = Boolean(row.name) && filter?.[view.filter] === row.name;
          return (
            <RankRow
              key={row.name}
              row={row}
              share={row.count / top}
              mono={view.mono}
              active={active}
              onPick={
                pick && row.name
                  ? () => pick({ [view.filter]: active ? undefined : row.name })
                  : undefined
              }
              href={
                projectId && row.name
                  ? recordingsHref(projectId, { [view.filter]: row.name })
                  : undefined
              }
            />
          );
        })
      )}
    </Panel>
  );
}

function ActiveFilters({
  filter,
  onFilter,
}: {
  filter: VisitFilter;
  onFilter: (patch: Partial<VisitFilter>) => void;
}) {
  const active = FILTER_KEYS.filter((key) => filter[key]);
  if (active.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {active.map((key) => (
        <Tag key={key} className="pr-0.5">
          {FILTER_LABEL[key]}
          <span className="max-w-56 truncate text-fg">{filterText(key, filter[key] ?? '')}</span>
          <button
            type="button"
            aria-label={`Remove ${FILTER_LABEL[key].toLowerCase()} filter`}
            onClick={() => onFilter({ [key]: undefined })}
            className="inline-flex size-4 items-center justify-center rounded-[4px] hover:bg-active hover:text-fg"
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        </Tag>
      ))}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onFilter(Object.fromEntries(FILTER_KEYS.map((key) => [key, undefined])))}
      >
        Clear
      </Button>
    </div>
  );
}

function Goals({
  goals,
  visits,
  projectId,
  goal,
  onGoal,
  className,
}: {
  goals: GoalStat[];
  visits: number;
  projectId?: string;
  goal?: string;
  onGoal?: (id: string) => void;
  className?: string;
}) {
  const pick = projectId ? onGoal : undefined;
  return (
    <Panel className={cn('pb-2', className)}>
      <PanelHeader
        title="Goals"
        description={
          pick && goals.length > 0
            ? 'Conversions and share of visits. Pick a goal to see its sources.'
            : 'Conversions and share of visits'
        }
      />
      {goals.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
          <p className="text-body text-fg-meta">No goals yet</p>
          {projectId ? (
            <LinkButton to={`/projects/${projectId}/settings/analytics`} size="sm">
              Add a goal
            </LinkButton>
          ) : null}
        </div>
      ) : (
        goals.map((entry) => {
          const on = entry.id === goal;
          const body = (
            <>
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className={cn('truncate text-control', on ? 'font-medium text-fg' : 'text-fg-secondary')}>
                  {entry.name}
                </span>
                <span className="truncate text-hint text-fg-meta">
                  {entry.kind === 'page' ? 'Page' : 'Event'}{' '}
                  <span className="font-mono">{entry.value}</span>
                </span>
              </span>
              <span className="tabular shrink-0 text-hint text-fg-meta">
                {rate(entry.conversions, visits)}
              </span>
              <span className="tabular w-12 shrink-0 text-right text-control text-fg">
                {compact(entry.conversions)}
              </span>
            </>
          );
          return pick ? (
            <button
              key={entry.id}
              type="button"
              aria-pressed={on}
              onClick={() => pick(on ? '' : entry.id)}
              className={cn(
                'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors duration-75 hover:bg-hover',
                on && 'bg-selected',
              )}
            >
              {body}
            </button>
          ) : (
            <div key={entry.id} className="flex items-center gap-3 px-4 py-2">
              {body}
            </div>
          );
        })
      )}
    </Panel>
  );
}

function Events({
  events,
  status,
  projectId,
}: {
  events?: EventStat[];
  status?: EventsStatus;
  projectId?: string;
}) {
  return (
    <Panel className="pb-2">
      <PanelHeader title="Events" description="Times fired, and the visits they happened in" />
      {events ? (
        events.length === 0 ? (
          <Quiet>
            Call <span className="font-mono text-mono">kimmi.track('signup')</span> in your site to
            see events here.
          </Quiet>
        ) : (
          events.map((entry) => {
            const automatic = AUTOMATIC[entry.name];
            const body = (
              <>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className={cn(
                      'truncate text-control text-fg-secondary',
                      !automatic && 'font-mono text-mono',
                    )}
                  >
                    {automatic ?? entry.name}
                  </span>
                  {entry.name.startsWith('$') ? <Tag>automatic</Tag> : null}
                </span>
                <span className="tabular shrink-0 text-hint text-fg-meta">
                  {compact(entry.visits)} {entry.visits === 1 ? 'visit' : 'visits'}
                  {entry.value !== 0 ? ` · ${amount(entry.value)} value` : ''}
                </span>
                <span className="tabular w-12 shrink-0 text-right text-control text-fg">
                  {compact(entry.count)}
                </span>
              </>
            );
            return projectId ? (
              <Link
                key={entry.name}
                to={recordingsHref(projectId, { event: `track:${entry.name}` })}
                className="flex items-center gap-3 px-4 py-2 transition-colors duration-75 hover:bg-hover"
              >
                {body}
              </Link>
            ) : (
              <div key={entry.name} className="flex items-center gap-3 px-4 py-2">
                {body}
              </div>
            );
          })
        )
      ) : status?.pending ? (
        <RankSkeleton rows={5} />
      ) : (
        <ErrorNote error={status?.error} onRetry={status?.retry} />
      )}
    </Panel>
  );
}

/**
 * Everything below the header of the traffic page. Without `projectId` it is
 * read-only, for a public link: no filters, no links to recordings.
 */
export function TrafficReport({
  traffic,
  days,
  projectId,
  events,
  eventsStatus,
  filter,
  onFilter,
  goal,
  onGoal,
}: {
  traffic: Traffic;
  days: Days;
  projectId?: string;
  events?: EventStat[];
  /** Lets the events panel show its loading and error states while `events` is undefined. */
  eventsStatus?: EventsStatus;
  filter?: VisitFilter;
  onFilter?: (patch: Partial<VisitFilter>) => void;
  goal?: string;
  onGoal?: (id: string) => void;
}) {
  const { totals, previous } = traffic;
  const chart = useMemo(
    () => traffic.days.map((day) => ({ ...day, label: shortDay(day.date) })),
    [traffic.days],
  );
  const filtered = FILTER_KEYS.some((key) => filter?.[key]);
  const shared = { projectId, filter, onFilter };

  const chips = filter && onFilter && projectId ? <ActiveFilters filter={filter} onFilter={onFilter} /> : null;

  if (totals.visits === 0 && !filtered) {
    return (
      <div className="rounded-xl border border-line bg-surface">
        <EmptyState
          icon={BarChart3}
          title="No visits in this window"
          description={
            projectId
              ? 'Visits appear here once the snippet is on your site and analytics is on.'
              : 'Visits appear here once the site has some.'
          }
          action={
            projectId ? (
              <LinkButton to={`/projects/${projectId}/settings/install`} variant="primary">
                Install kimmi
              </LinkButton>
            ) : undefined
          }
        />
      </div>
    );
  }

  const delta = (current: number, before: number, lowerIsBetter = false) => {
    const value = change(current, before);
    if (value === null) return {};
    const good = lowerIsBetter ? value <= 0 : value >= 0;
    return { delta: signed(value), deltaTone: good ? ('good' as const) : ('bad' as const) };
  };
  const per = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
  const depth = per(totals.pageviews, totals.visits);

  const converted = new Map(traffic.goalSources.map((entry) => [entry.name, entry.count]));
  const picked = goal ? traffic.goals.find((entry) => entry.id === goal) : undefined;
  const showEvents = events !== undefined || eventsStatus !== undefined;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Figure
          label="Visitors"
          value={compact(totals.visitors)}
          detail={`${compact(totals.newVisitors)} new, ${compact(totals.returning)} returning`}
          {...delta(totals.visitors, previous.visitors)}
        />
        <Figure
          label="Visits"
          value={compact(totals.visits)}
          {...delta(totals.visits, previous.visits)}
        />
        <Figure
          label="Page views"
          value={compact(totals.pageviews)}
          {...delta(totals.pageviews, previous.pageviews)}
        />
        <Figure
          label="Bounce rate"
          value={rate(totals.bounces, totals.visits)}
          detail={`${compact(totals.bounces)} visits left after one page`}
          {...delta(per(totals.bounces, totals.visits), per(previous.bounces, previous.visits), true)}
        />
        <Figure
          label="Visit duration"
          value={duration(totals.avgDurationMs)}
          {...delta(totals.avgDurationMs, previous.avgDurationMs)}
        />
        <Figure
          label="Views per visit"
          value={depth.toFixed(1)}
          {...delta(depth, per(previous.pageviews, previous.visits))}
        />
      </div>

      <Panel className="mt-3">
        <PanelHeader
          title="Visitors over time"
          description={
            days === 1
              ? `${compact(totals.visitors)} visitors today`
              : `${compact(totals.visitors)} visitors in the last ${days} days`
          }
        />
        <VisitorsChart days={chart} />
      </Panel>

      {chips}

      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        <Breakdowns
          title="Sources"
          description={
            picked ? `Where visits come from, and how many reached ${picked.name}` : 'Where visits come from'
          }
          views={[
            {
              value: 'sources',
              label: 'Sources',
              filter: 'referrer',
              rows: ranks(traffic.sources, undefined, (name) => {
                if (!picked) return undefined;
                const count = converted.get(name) ?? 0;
                return (
                  <span className={count > 0 ? 'text-brand-fg' : undefined}>
                    {compact(count)} converted
                  </span>
                );
              }),
            },
            { value: 'channels', label: 'Channels', filter: 'channel', rows: ranks(traffic.channels) },
            {
              value: 'campaigns',
              label: 'Campaigns',
              filter: 'utmCampaign',
              rows: ranks(traffic.campaigns),
            },
          ]}
          {...shared}
        />
        <Breakdowns
          title="Pages"
          description="Visitors, with views, average time and scroll depth"
          views={[
            {
              value: 'top',
              label: 'Top pages',
              filter: 'path',
              mono: true,
              rows: traffic.pages.map((page) => ({
                name: page.path,
                label: page.path,
                count: page.visitors,
                detail: (
                  <span className="hidden sm:inline">
                    {compact(page.views)} views · {duration(page.avgTimeMs)}
                    {page.scroll > 0 ? ` · ${Math.round(page.scroll)}%` : ''}
                  </span>
                ),
              })),
            },
            {
              value: 'entry',
              label: 'Entry pages',
              filter: 'entry',
              mono: true,
              rows: ranks(traffic.entryPages),
            },
            {
              value: 'exit',
              label: 'Exit pages',
              filter: 'exit',
              mono: true,
              rows: ranks(traffic.exitPages),
            },
          ]}
          {...shared}
        />
        <Breakdowns
          title="Countries"
          description="Where visitors are"
          views={[
            {
              value: 'countries',
              label: 'Countries',
              filter: 'country',
              rows: ranks(traffic.countries, countryLabel),
            },
          ]}
          {...shared}
        />
        <Breakdowns
          title="Devices"
          description="What visitors browse with"
          views={[
            { value: 'devices', label: 'Devices', filter: 'device', rows: ranks(traffic.devices) },
            { value: 'browsers', label: 'Browsers', filter: 'browser', rows: ranks(traffic.browsers) },
            { value: 'systems', label: 'Systems', filter: 'os', rows: ranks(traffic.systems) },
            {
              value: 'languages',
              label: 'Languages',
              filter: 'language',
              rows: ranks(traffic.languages, languageName),
            },
          ]}
          {...shared}
        />
        <Goals
          goals={traffic.goals}
          visits={totals.visits}
          projectId={projectId}
          goal={goal}
          onGoal={onGoal}
          className={showEvents ? undefined : 'xl:col-span-2'}
        />
        {showEvents ? <Events events={events} status={eventsStatus} projectId={projectId} /> : null}
      </div>
    </>
  );
}

function useReportParams() {
  const [params, setParams] = useSearchParams();
  const asked = Number(params.get('days'));
  const days = WINDOWS.find((entry) => entry === asked) ?? 7;
  const filter: VisitFilter = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) filter[key] = value;
  }
  const goal = params.get('goal') ?? '';

  const patch = useCallback(
    (next: Record<string, string | undefined>) =>
      setParams(
        (current) => {
          const out = new URLSearchParams(current);
          for (const [key, value] of Object.entries(next)) {
            if (value) out.set(key, value);
            else out.delete(key);
          }
          return out;
        },
        { replace: true },
      ),
    [setParams],
  );
  return { days, filter, goal, patch };
}

export function Analytics() {
  const { projectId = '' } = useParams();
  const { days, filter, goal, patch } = useReportParams();
  const traffic = useTraffic(projectId, days, filter, goal);
  const events = useEventNames(projectId, days);

  return (
    <Page>
      <PageHeader
        title="Analytics"
        description="Who visits, where they come from and what they look at"
        actions={
          <Select
            label="Time range"
            value={String(days)}
            onChange={(next) => patch({ days: next === '7' ? undefined : next })}
            icon={CalendarDays}
            className="w-28"
            options={WINDOWS.map((entry) => ({
              value: String(entry),
              label: entry === 1 ? 'Today' : `${entry} days`,
            }))}
          />
        }
      />

      {traffic.isPending ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => index).map((_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
              <FigureSkeleton key={index} />
            ))}
          </div>
          <Panel className="mt-3">
            <PanelHeader title="Visitors over time" description={<Skeleton className="mt-1 h-3 w-40" />} />
            <div className="px-4 pb-4">
              <Skeleton className="h-56 w-full" />
            </div>
          </Panel>
          <div className="mt-3 grid gap-3 xl:grid-cols-2">
            {['Sources', 'Pages'].map((title) => (
              <Panel key={title} className="pb-2">
                <PanelHeader title={title} />
                <RankSkeleton rows={6} />
              </Panel>
            ))}
          </div>
        </>
      ) : !traffic.data ? (
        <Panel>
          <ErrorNote error={traffic.error} onRetry={() => void traffic.refetch()} />
        </Panel>
      ) : (
        <TrafficReport
          traffic={traffic.data}
          days={days}
          projectId={projectId}
          events={events.data}
          eventsStatus={{
            pending: events.isPending,
            error: events.error,
            retry: () => void events.refetch(),
          }}
          filter={filter}
          onFilter={patch}
          goal={goal}
          onGoal={(id) => patch({ goal: id || undefined })}
        />
      )}
    </Page>
  );
}

