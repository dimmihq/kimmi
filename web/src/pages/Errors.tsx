import { TriangleAlert } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useErrorGroups } from '@/api/analytics';
import { ago, compact } from '@/lib/format';
import { ErrorNote, SkeletonRows } from '@/shell/states';
import { EmptyState, Page, PageHeader, Tag } from '@/ui';
import { DaysPicker, useDays, windowStart } from './analytics/window';

export function Errors() {
  const { projectId = '' } = useParams();
  const [days, setDays] = useDays();
  const list = useErrorGroups(projectId, days);
  const groups = list.data;
  const since = windowStart(days);
  const query = days === 7 ? '' : `?days=${days}`;

  return (
    <Page>
      <PageHeader
        title="Errors"
        description="Uncaught errors in the browser, grouped by where they were thrown"
        actions={<DaysPicker value={days} onChange={setDays} />}
      />

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex h-[38px] items-center gap-6 border-b border-line-subtle px-4 text-label text-fg-meta">
          <span className="min-w-0 flex-1">Error</span>
          <span className="w-24 shrink-0 text-right">Visits affected</span>
          <span className="hidden w-24 shrink-0 text-right sm:block">Occurrences</span>
          <span className="hidden w-20 shrink-0 text-right md:block">First seen</span>
          <span className="w-20 shrink-0 text-right">Last seen</span>
        </div>

        {list.isPending ? (
          <SkeletonRows count={8} />
        ) : !groups ? (
          <ErrorNote error={list.error} onRetry={() => void list.refetch()} />
        ) : groups.length === 0 ? (
          <EmptyState
            icon={TriangleAlert}
            title="No uncaught errors in this window"
            description="An error that a visitor's browser throws and nothing catches is listed here, with the recordings it happened in."
          />
        ) : (
          groups.map((group) => (
            <Link
              key={group.fingerprint}
              to={`/projects/${projectId}/errors/${encodeURIComponent(group.fingerprint)}${query}`}
              className="flex h-12 items-center gap-6 border-b border-line-subtle px-4 transition-colors duration-75 last:border-b-0 hover:bg-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-mono text-danger-fg">{group.message}</span>
                  {group.firstSeen >= since ? <Tag tone="info">New</Tag> : null}
                </span>
                <span className="block truncate font-mono text-[0.65rem] text-fg-ghost">
                  {[group.source, group.path].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="tabular w-24 shrink-0 text-right text-control text-fg">
                {compact(group.visits)}
              </span>
              <span className="tabular hidden w-24 shrink-0 text-right text-control text-fg-secondary sm:block">
                {compact(group.count)}
              </span>
              <span className="tabular hidden w-20 shrink-0 text-right text-control text-fg-muted md:block">
                {ago(group.firstSeen)}
              </span>
              <span className="tabular w-20 shrink-0 text-right text-control text-fg-meta">
                {ago(group.lastSeen)}
              </span>
            </Link>
          ))
        )}
      </div>
    </Page>
  );
}
