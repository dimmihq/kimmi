import { Link, useParams } from 'react-router-dom';
import { type PageVitals, recordingsHref, useRequests, useVitals } from '@/api/analytics';
import { ago, compact } from '@/lib/format';
import { ErrorNote, Skeleton, SkeletonRows } from '@/shell/states';
import { cn, Figure, Page, PageHeader, Panel, PanelHeader, Tag } from '@/ui';
import { DaysPicker, useDays } from './analytics/window';

type Metric = 'lcp' | 'inp' | 'cls' | 'fcp' | 'ttfb';
type Rating = 'good' | 'needs work' | 'poor';

/** A timing in milliseconds: "640 ms" or "2.41 s". */
const time = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

/** The standard web vitals thresholds: up to `good` is good, over `poor` is poor. */
const METRICS: { id: Metric; label: string; name: string; good: number; poor: number; format: (value: number) => string }[] = [
  { id: 'lcp', label: 'LCP', name: 'Largest contentful paint', good: 2500, poor: 4000, format: time },
  { id: 'inp', label: 'INP', name: 'Interaction to next paint', good: 200, poor: 500, format: time },
  { id: 'cls', label: 'CLS', name: 'Cumulative layout shift', good: 0.1, poor: 0.25, format: (value) => value.toFixed(2) },
  { id: 'fcp', label: 'FCP', name: 'First contentful paint', good: 1800, poor: 3000, format: time },
  { id: 'ttfb', label: 'TTFB', name: 'Time to first byte', good: 800, poor: 1800, format: time },
];

const rate = (value: number, good: number, poor: number): Rating =>
  value <= good ? 'good' : value <= poor ? 'needs work' : 'poor';

const RATING_TONE = { good: 'brand', 'needs work': 'warning', poor: 'danger' } as const;
const RATING_TEXT = {
  good: 'text-fg-secondary',
  'needs work': 'text-warning-fg',
  poor: 'text-danger-fg',
} as const;

const NOT_MEASURED = '—';

export function Performance() {
  const { projectId = '' } = useParams();
  const [days, setDays] = useDays();
  const vitals = useVitals(projectId, days);
  const requests = useRequests(projectId, days);

  const site = vitals.data?.find((row) => row.path === '');
  const pages = (vitals.data ?? [])
    .filter((row) => row.path !== '')
    .sort((a, b) => b.lcp - a.lcp);
  const measured = Boolean(vitals.data && vitals.data.length > 0);

  return (
    <Page>
      <PageHeader
        title="Performance"
        description="Web vitals at the 75th percentile, and the requests that fail or drag"
        actions={<DaysPicker value={days} onChange={setDays} />}
      />

      {vitals.isPending ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {METRICS.map((metric) => (
            <Panel key={metric.id} className="flex min-h-[104px] flex-col px-4 py-3.5">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="mt-3 h-6 w-20" />
              <Skeleton className="mt-2.5 h-3 w-28" />
            </Panel>
          ))}
        </div>
      ) : !vitals.data ? (
        <Panel>
          <ErrorNote error={vitals.error} onRetry={() => void vitals.refetch()} />
        </Panel>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {METRICS.map((metric) => {
            const value = site ? site[metric.id] : -1;
            const rating = value < 0 ? null : rate(value, metric.good, metric.poor);
            return (
              <Figure
                key={metric.id}
                label={metric.label}
                value={value < 0 ? NOT_MEASURED : metric.format(value)}
                detail={value < 0 ? 'not measured' : metric.name}
              >
                {rating ? <Tag tone={RATING_TONE[rating]}>{rating}</Tag> : null}
              </Figure>
            );
          })}
        </div>
      )}

      <Panel className="mt-3 overflow-hidden">
        <PanelHeader
          title="Slowest pages"
          description={
            site ? `${compact(site.samples)} page loads measured in this window` : 'Sorted by largest contentful paint'
          }
        />
        <div className="flex h-[38px] items-center gap-4 border-y border-line-subtle px-4 text-label text-fg-meta">
          <span className="min-w-0 flex-1">Page</span>
          {METRICS.map((metric) => (
            <span
              key={metric.id}
              className={cn('w-16 shrink-0 text-right', metric.id !== 'lcp' && 'hidden md:block')}
            >
              {metric.label}
            </span>
          ))}
          <span className="w-16 shrink-0 text-right">Samples</span>
        </div>
        {vitals.isPending ? (
          <SkeletonRows count={5} className="h-10" />
        ) : !vitals.data ? (
          <ErrorNote error={vitals.error} onRetry={() => void vitals.refetch()} />
        ) : pages.length === 0 ? (
          <p className="px-4 py-10 text-center text-body text-fg-meta">
            {measured
              ? 'No single page has enough page loads yet.'
              : 'Web vitals appear here once Performance timings is on in the capture settings and a few pages have loaded.'}{' '}
            {measured ? null : (
              <Link
                to={`/projects/${projectId}/settings/capture`}
                className="text-fg-secondary underline underline-offset-2 hover:text-fg"
              >
                Capture settings
              </Link>
            )}
          </p>
        ) : (
          pages.map((row) => (
            <Link
              key={row.path}
              to={recordingsHref(projectId, { path: row.path })}
              className="flex h-10 items-center gap-4 border-b border-line-subtle px-4 transition-colors duration-75 last:border-b-0 hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-mono text-fg-secondary">
                {row.path}
              </span>
              {METRICS.map((metric) => (
                <Vital key={metric.id} row={row} metric={metric} />
              ))}
              <span className="tabular w-16 shrink-0 text-right text-control text-fg-muted">
                {compact(row.samples)}
              </span>
            </Link>
          ))
        )}
      </Panel>

      <Panel className="mt-3 overflow-hidden">
        <PanelHeader
          title="Failing and slow requests"
          description="Requests that failed or took over 3 s"
        />
        <div className="flex h-[38px] items-center gap-4 border-y border-line-subtle px-4 text-label text-fg-meta">
          <span className="min-w-0 flex-1">Request</span>
          <span className="w-14 shrink-0 text-right">Failed</span>
          <span className="hidden w-14 shrink-0 text-right sm:block">Total</span>
          <span className="hidden w-14 shrink-0 text-right md:block">Status</span>
          <span className="hidden w-20 shrink-0 text-right md:block">Average</span>
          <span className="hidden w-14 shrink-0 text-right lg:block">Visits</span>
          <span className="w-20 shrink-0 text-right">Last seen</span>
        </div>
        {requests.isPending ? (
          <SkeletonRows count={5} className="h-10" />
        ) : !requests.data ? (
          <ErrorNote error={requests.error} onRetry={() => void requests.refetch()} />
        ) : requests.data.length === 0 ? (
          <p className="px-4 py-10 text-center text-body text-fg-meta">
            No request failed or took over 3 s in this window. Requests are listed here when they do.
          </p>
        ) : (
          requests.data.map((request) => {
            const space = request.name.indexOf(' ');
            const method = space > 0 ? request.name.slice(0, space) : '';
            const target = space > 0 ? request.name.slice(space + 1) : request.name;
            return (
              <Link
                key={request.name}
                to={recordingsHref(projectId, { event: `request:${request.name}` })}
                className="flex h-10 items-center gap-4 border-b border-line-subtle px-4 transition-colors duration-75 last:border-b-0 hover:bg-hover"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {method ? <Tag>{method}</Tag> : null}
                  <span className="truncate font-mono text-mono text-fg-secondary">{target}</span>
                </span>
                <span
                  className={cn(
                    'tabular w-14 shrink-0 text-right text-control',
                    request.failed > 0 ? 'text-danger-fg' : 'text-fg-ghost',
                  )}
                >
                  {compact(request.failed)}
                </span>
                <span className="tabular hidden w-14 shrink-0 text-right text-control text-fg-muted sm:block">
                  {compact(request.count)}
                </span>
                <span
                  className={cn(
                    'tabular hidden w-14 shrink-0 text-right font-mono text-mono md:block',
                    request.status >= 400 || request.status === 0 ? 'text-danger-fg' : 'text-fg-muted',
                  )}
                >
                  {request.status > 0 ? request.status : NOT_MEASURED}
                </span>
                <span className="tabular hidden w-20 shrink-0 text-right text-control text-fg-secondary md:block">
                  {time(request.avgMs)}
                </span>
                <span className="tabular hidden w-14 shrink-0 text-right text-control text-fg-muted lg:block">
                  {compact(request.visits)}
                </span>
                <span className="tabular w-20 shrink-0 text-right text-control text-fg-meta">
                  {ago(request.lastSeen)}
                </span>
              </Link>
            );
          })
        )}
      </Panel>
    </Page>
  );
}

function Vital({ row, metric }: { row: PageVitals; metric: (typeof METRICS)[number] }) {
  const value = row[metric.id];
  return (
    <span
      className={cn(
        'tabular w-16 shrink-0 text-right text-control',
        metric.id !== 'lcp' && 'hidden md:block',
        value < 0 ? 'text-fg-ghost' : RATING_TEXT[rate(value, metric.good, metric.poor)],
      )}
    >
      {value < 0 ? NOT_MEASURED : metric.format(value)}
    </span>
  );
}
