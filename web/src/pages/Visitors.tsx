import { ArrowUpDown, Building2, ChevronLeft, ChevronRight, Repeat, Search, UsersRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAccounts, useRetention } from '@/api/analytics';
import { useVisitors, type VisitorKind, type VisitorSort, visitorLabel } from '@/api/app';
import type { Project } from '@/api/types';
import { ago, compact, flag } from '@/lib/format';
import { useProjectScope } from '@/shell/AppFrame';
import { ErrorNote, Skeleton, SkeletonRows, useDebounced } from '@/shell/states';
import {
  Avatar,
  cn,
  EmptyState,
  Figure,
  IconButton,
  Input,
  Page,
  PageHeader,
  Panel,
  Select,
  Tabs,
} from '@/ui';

const PER_PAGE = 25;

type Tab = 'people' | 'returning' | 'accounts';
const TABS: Tab[] = ['people', 'returning', 'accounts'];
const TAB_LABEL: Record<Tab, string> = { people: 'People', returning: 'Returning', accounts: 'Accounts' };

const WEEKS = 8;

/** The accent, stronger the more of a cohort came back. */
const TINT = [
  'bg-brand/4',
  'bg-brand/8',
  'bg-brand/12',
  'bg-brand/16',
  'bg-brand/20',
  'bg-brand/24',
  'bg-brand/28',
  'bg-brand/32',
  'bg-brand/36',
  'bg-brand/40',
];

/** "2026-11-23" as "23 Nov", in the viewer's locale. */
const weekLabel = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function FigureSkeleton() {
  return (
    <Panel className="flex min-h-[104px] flex-col px-4 py-3.5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-6 w-20" />
      <Skeleton className="mt-2.5 h-3 w-28" />
    </Panel>
  );
}

function Returning({ current }: { current: Project }) {
  const retention = useRetention(current.id);
  const data = retention.data;

  if (retention.isPending) {
    return (
      <>
        <div className="grid gap-3 sm:grid-cols-3">
          <FigureSkeleton />
          <FigureSkeleton />
          <FigureSkeleton />
        </div>
        <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface">
          <SkeletonRows count={6} />
        </div>
      </>
    );
  }
  if (!data) {
    return (
      <div className="rounded-xl border border-line bg-surface">
        <ErrorNote error={retention.error} onRetry={() => void retention.refetch()} />
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Figure label="Active in the last day" value={compact(data.daily)} detail="visitors" />
        <Figure label="Active in the last 7 days" value={compact(data.weekly)} detail="visitors" />
        <Figure label="Active in the last 30 days" value={compact(data.monthly)} detail="visitors" />
      </div>

      {data.cohorts.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="No cohorts yet"
          description="Once visitors have been counted for a week, this shows how many of each week's new visitors came back."
        />
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <caption className="sr-only">
              Share of each week's new visitors who were active in the weeks after
            </caption>
            <thead>
              <tr className="h-[38px] border-b border-line-subtle text-label text-fg-meta">
                <th scope="col" className="px-4 font-medium">
                  Week starting
                </th>
                <th scope="col" className="w-20 px-2 text-right font-medium">
                  Visitors
                </th>
                {Array.from({ length: WEEKS }, (_, week) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed series
                  <th key={week} scope="col" className="w-[72px] px-1 text-center font-medium">
                    Week {week}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.cohorts.map((cohort) => (
                <tr key={cohort.week} className="h-12 border-b border-line-subtle last:border-b-0">
                  <th scope="row" className="px-4 text-control font-medium text-fg">
                    {weekLabel(cohort.week)}
                  </th>
                  <td className="tabular px-2 text-right text-control text-fg-secondary">
                    {compact(cohort.size)}
                  </td>
                  {Array.from({ length: WEEKS }, (_, week) => {
                    const active = cohort.active[week];
                    // A week that has not happened yet.
                    if (active === undefined || cohort.size === 0) {
                      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed series
                      return <td key={week} className="px-1" />;
                    }
                    const share = Math.min(1, active / cohort.size);
                    const tint =
                      share > 0 ? TINT[Math.min(TINT.length - 1, Math.floor(share * TINT.length))] : null;
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed series
                      <td key={week} className="px-1">
                        <span
                          title={`${active} of ${cohort.size} visitors`}
                          className={cn(
                            'tabular flex h-8 items-center justify-center rounded-md text-control',
                            tint,
                            share > 0 ? 'text-fg' : 'text-fg-ghost',
                          )}
                        >
                          {Math.round(share * 100)}%
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-meta text-fg-meta">
        Visitors counted without cookies are not included: they get a new identity every day.
      </p>
    </>
  );
}

function Accounts({ current }: { current: Project }) {
  const accounts = useAccounts(current.id);
  const data = accounts.data;

  if (accounts.isPending) {
    return (
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <SkeletonRows count={8} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-xl border border-line bg-surface">
        <ErrorNote error={accounts.error} onRetry={() => void accounts.refetch()} />
      </div>
    );
  }
  if (data.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No accounts yet"
        description={
          <>
            Call <code className="font-mono text-mono">kimmi.identify(id, {'{ email }'})</code> in
            your site and people are grouped by the domain of their email. Personal mail domains
            are left out.
          </>
        }
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex h-[38px] items-center gap-4 border-b border-line-subtle px-4 text-label text-fg-meta">
        <span className="min-w-0 flex-1">Domain</span>
        <span className="w-16 text-right">People</span>
        <span className="w-16 text-right">Sessions</span>
        <span className="w-20 text-right">Last seen</span>
      </div>
      {data.map((entry) => (
        <Link
          key={entry.domain}
          to={`/projects/${current.id}/visitors?q=${encodeURIComponent(`@${entry.domain}`)}`}
          className="flex h-12 items-center gap-4 border-b border-line-subtle px-4 last:border-b-0 hover:bg-hover"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Avatar name={entry.domain} />
            <span className="truncate text-control text-fg">{entry.domain}</span>
          </div>
          <span className="tabular w-16 text-right text-control text-fg">
            {compact(entry.people)}
          </span>
          <span className="tabular w-16 text-right text-control text-fg-muted">
            {compact(entry.sessions)}
          </span>
          <span className="tabular w-20 text-right text-control text-fg-secondary">
            {ago(entry.lastSeen)}
          </span>
        </Link>
      ))}
    </div>
  );
}

export function Visitors() {
  const current = useProjectScope();
  const [params, setParams] = useSearchParams();
  // Returning visitors are counted from visits, so the tab needs analytics.
  const tabs = TABS.filter((entry) => entry !== 'returning' || current.analytics);
  const tab = tabs.find((entry) => entry === params.get('tab')) ?? 'people';
  // The header counts everyone, whatever the list below is narrowed to.
  const everyone = useVisitors(current.id, {
    q: '',
    kind: 'all',
    sort: 'lastSeen',
    page: 0,
    limit: PER_PAGE,
  }).data;

  return (
    <Page>
      <PageHeader
        title="Visitors"
        description={
          everyone ? (
            `${compact(everyone.counts.all)} people recorded on ${current.origin.replace(/^https?:\/\//, '')} · ${compact(everyone.counts.identified)} identified`
          ) : (
            <Skeleton className="mt-1.5 h-3 w-72" />
          )
        }
      />

      <div className="mb-4">
        <Tabs
          label="Visitor views"
          value={tab}
          onChange={(next) =>
            setParams(
              (now) => {
                const out = new URLSearchParams(now);
                if (next === 'people') out.delete('tab');
                else out.set('tab', next);
                if (next !== 'people') out.delete('q');
                return out;
              },
              { replace: true },
            )
          }
          options={tabs.map((value) => ({ value, label: TAB_LABEL[value] }))}
        />
      </div>

      {tab === 'returning' ? (
        <Returning current={current} />
      ) : tab === 'accounts' ? (
        <Accounts current={current} />
      ) : (
        <People current={current} />
      )}
    </Page>
  );
}

function People({ current }: { current: Project }) {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const [kind, setKind] = useState<VisitorKind>('all');
  const [sort, setSort] = useState<VisitorSort>('lastSeen');
  const [page, setPage] = useState(0);
  const q = useDebounced(query, 300);
  // A new search starts from the first page once it settles.
  const [lastQ, setLastQ] = useState(q);
  if (lastQ !== q) {
    setLastQ(q);
    setPage(0);
  }
  // The search stays in the address, so a filtered list can be linked to.
  useEffect(() => {
    setParams(
      (now) => {
        if ((now.get('q') ?? '') === q) return now;
        const out = new URLSearchParams(now);
        if (q) out.set('q', q);
        else out.delete('q');
        return out;
      },
      { replace: true },
    );
  }, [q, setParams]);

  const visitors = useVisitors(current.id, { q, kind, sort, page, limit: PER_PAGE });
  const data = visitors.data;
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const at = Math.min(page, pages - 1);
  const shown = data?.items ?? [];
  const searching = q.trim() !== '' || kind !== 'all';

  return (
    <>
      <div className="mb-3 flex gap-2">
        <Input
          icon={Search}
          placeholder="Search by name, email, id or place"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-9"
        />
        <Select
          label="Sort visitors"
          value={sort}
          onChange={(next) => {
            setSort(next);
            setPage(0);
          }}
          icon={ArrowUpDown}
          className="h-9 w-44"
          options={[
            { value: 'lastSeen', label: 'Last seen' },
            { value: 'sessions', label: 'Most sessions' },
            { value: 'firstSeen', label: 'First seen' },
          ]}
        />
      </div>

      <div className="mb-4">
        <Tabs
          label="Visitor kind"
          value={kind}
          onChange={(next) => {
            setKind(next);
            setPage(0);
          }}
          options={[
            { value: 'all', label: 'All', count: data?.counts.all },
            { value: 'identified', label: 'Identified', count: data?.counts.identified },
            { value: 'anonymous', label: 'Anonymous', count: data?.counts.anonymous },
          ]}
        />
      </div>

      {visitors.isPending ? (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <SkeletonRows count={8} />
        </div>
      ) : !data ? (
        <div className="rounded-xl border border-line bg-surface">
          <ErrorNote error={visitors.error} onRetry={() => void visitors.refetch()} />
        </div>
      ) : shown.length === 0 ? (
        searching ? (
          <EmptyState
            icon={UsersRound}
            title="No visitor matches"
            description="Try another name, email, visitor id or city."
          />
        ) : (
          <EmptyState
            icon={UsersRound}
            title="No visitors yet"
            description="Everyone who opens a page with the kimmi snippet shows up here, named once you call identify."
          />
        )
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex h-[38px] items-center gap-4 border-b border-line-subtle px-4 text-label text-fg-meta">
            <span className="min-w-0 flex-1">Visitor</span>
            <span className="hidden w-52 xl:block">Email</span>
            <span className="hidden w-36 md:block">Location</span>
            <span className="hidden w-40 lg:block">Device</span>
            <span className="w-16 text-right">Sessions</span>
            <span className="hidden w-20 text-right sm:block">First seen</span>
            <span className="w-20 text-right">Last seen</span>
          </div>
          {shown.map((entry) => (
            <Link
              key={entry.id}
              to={`/projects/${current.id}/visitors/${entry.id}`}
              className="flex h-12 items-center gap-4 border-b border-line-subtle px-4 hover:bg-hover"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Avatar name={visitorLabel(entry)} />
                <div className="min-w-0">
                  <div
                    className={cn(
                      'truncate text-fg',
                      entry.name ? 'text-control' : 'font-mono text-mono',
                    )}
                  >
                    {visitorLabel(entry)}
                  </div>
                  {entry.email ? (
                    <div className="truncate text-hint text-fg-meta xl:hidden">{entry.email}</div>
                  ) : null}
                </div>
              </div>
              <span className="hidden w-52 truncate text-control text-fg-muted xl:block">
                {entry.email ?? <span className="text-fg-ghost">Not identified</span>}
              </span>
              <span className="hidden w-36 truncate text-control text-fg-muted md:block">
                <span className="mr-1.5">{flag(entry.countryCode)}</span>
                {entry.city}
              </span>
              <span className="hidden w-40 truncate text-control text-fg-muted lg:block">
                {entry.device} · {entry.browser}
              </span>
              <span className="tabular w-16 text-right text-control text-fg">{entry.sessions}</span>
              <span className="tabular hidden w-20 text-right text-control text-fg-muted sm:block">
                {ago(entry.firstSeen)}
              </span>
              <span className="tabular w-20 text-right text-control text-fg-secondary">
                {ago(entry.lastSeen)}
              </span>
            </Link>
          ))}
          <div className="flex h-11 items-center justify-between pl-4 pr-2">
            <span className="tabular text-hint text-fg-meta">
              {at * PER_PAGE + 1}–{at * PER_PAGE + shown.length} of {total}
            </span>
            <div className="flex items-center gap-1">
              <IconButton
                icon={ChevronLeft}
                label="Previous page"
                disabled={at === 0}
                onClick={() => setPage(at - 1)}
              />
              <span className="tabular px-1 text-hint text-fg-meta">
                Page {at + 1} of {pages}
              </span>
              <IconButton
                icon={ChevronRight}
                label="Next page"
                disabled={at >= pages - 1}
                onClick={() => setPage(at + 1)}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
