import { ArrowUpDown, ChevronLeft, ChevronRight, Search, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useVisitors, type VisitorKind, type VisitorSort, visitorLabel } from '@/api/app';
import { ago, compact, flag } from '@/lib/format';
import { useProjectScope } from '@/shell/AppFrame';
import { ErrorNote, Skeleton, SkeletonRows, useDebounced } from '@/shell/states';
import {
  Avatar,
  cn,
  EmptyState,
  IconButton,
  Input,
  Page,
  PageHeader,
  Select,
  Tabs,
} from '@/ui';

const PER_PAGE = 25;

export function Visitors() {
  const current = useProjectScope();
  const [query, setQuery] = useState('');
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

  const visitors = useVisitors(current.id, { q, kind, sort, page, limit: PER_PAGE });
  const data = visitors.data;
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const at = Math.min(page, pages - 1);
  const shown = data?.items ?? [];
  const searching = q.trim() !== '' || kind !== 'all';

  return (
    <Page>
      <PageHeader
        title="Visitors"
        description={
          data ? (
            `${compact(data.counts.all)} people recorded on ${current.origin.replace(/^https?:\/\//, '')} · ${compact(data.counts.identified)} identified`
          ) : (
            <Skeleton className="mt-1.5 h-3 w-72" />
          )
        }
      />

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
    </Page>
  );
}
