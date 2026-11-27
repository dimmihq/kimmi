import { Play, Radio } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLive, visitorLabel } from '@/api/app';
import { duration, flag } from '@/lib/format';
import { useProjectScope } from '@/shell/AppFrame';
import { ErrorNote, Skeleton, SkeletonRows, useNow } from '@/shell/states';
import {
  Avatar,
  cn,
  EmptyState,
  Figure,
  LinkButton,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Tag,
} from '@/ui';

function Breakdown({
  rows,
}: {
  rows: { key: string; label: ReactNode; count: number }[];
}) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <ul className="flex flex-col gap-3 px-4 pb-4">
      {rows.map((row) => (
        <li key={row.key}>
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-control text-fg-secondary">{row.label}</span>
            <span className="tabular text-control text-fg">{row.count}</span>
          </div>
          <div className="mt-1.5 h-1 rounded-full bg-active">
            <div
              className="h-full rounded-full bg-fg-ghost"
              style={{ width: `${(row.count / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function LiveSkeleton({ host }: { host: string }) {
  return (
    <Page>
      <PageHeader title="Live" description={`Visitors on ${host} right now`} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {['a', 'b', 'c'].map((key) => (
          <Panel key={key} className="flex min-h-[104px] flex-col px-4 py-3.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-6 w-12" />
            <Skeleton className="mt-2.5 h-3 w-32" />
          </Panel>
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <SkeletonRows count={6} />
      </div>
    </Page>
  );
}

export function Live() {
  const current = useProjectScope();
  const live = useLive(current.id);
  const now = useNow();
  const host = current.origin.replace(/^https?:\/\//, '');
  const data = live.data;

  if (live.isPending) return <LiveSkeleton host={host} />;

  if (!data) {
    return (
      <Page>
        <PageHeader title="Live" description={`Visitors on ${host} right now`} />
        <div className="rounded-xl border border-line bg-surface">
          <ErrorNote error={live.error} onRetry={() => void live.refetch()} />
        </div>
      </Page>
    );
  }

  if (data.visitors === 0) {
    return (
      <Page>
        <PageHeader title="Live" description={`No visitors on ${host} right now`} />
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState
            icon={Radio}
            title="No one is on the site right now"
            description="Sessions show up here a few seconds after a visitor opens a page with the kimmi snippet."
            action={
              <LinkButton to={`/projects/${current.id}/settings/install`}>
                Check the install
              </LinkButton>
            }
          />
        </div>
      </Page>
    );
  }

  const rows = data.sessions;

  return (
    <Page>
      <PageHeader
        title="Live"
        description={`${data.visitors} ${data.visitors === 1 ? 'visitor' : 'visitors'} on ${host} right now`}
        actions={
          <Tag tone="brand" dot>
            Live
          </Tag>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Figure label="Live visitors" value={data.visitors} detail="With a page open right now" />
        <Figure
          label="Active in last 5 min"
          value={data.activeLast5m}
          detail="Including visitors who just left"
        />
        <Figure label="Pages being viewed" value={data.pages.length} detail="Different paths open" />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex h-[38px] items-center gap-4 border-b border-line-subtle px-4 text-label text-fg-meta">
            <span className="min-w-0 flex-1">Visitor</span>
            <span className="hidden w-36 md:block">Location</span>
            <span className="hidden w-44 sm:block">Current page</span>
            <span className="hidden w-36 lg:block">Device</span>
            <span className="w-14 text-right">On site</span>
            <span className="w-[88px]" />
          </div>
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex h-12 items-center gap-4 border-b border-line-subtle px-4 last:border-b-0 hover:bg-hover"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Avatar name={visitorLabel(row.visitor)} />
                <span
                  className={cn(
                    'truncate text-fg',
                    row.visitor.name ? 'text-control' : 'font-mono text-mono',
                  )}
                >
                  {visitorLabel(row.visitor)}
                </span>
              </div>
              <span className="hidden w-36 truncate text-control text-fg-muted md:block">
                <span className="mr-1.5">{flag(row.visitor.countryCode)}</span>
                {row.visitor.city}
              </span>
              <span className="hidden w-44 truncate font-mono text-mono text-fg-secondary sm:block">
                {row.currentPath}
              </span>
              <span className="hidden w-36 truncate text-control text-fg-muted lg:block">
                {row.visitor.device} · {row.visitor.browser}
              </span>
              <span className="tabular w-14 text-right text-control text-fg-secondary">
                {duration(now - row.startedAt)}
              </span>
              <span className="flex w-[88px] justify-end">
                <LinkButton
                  to={`/projects/${current.id}/recordings/${row.id}`}
                  size="sm"
                  icon={Play}
                >
                  Watch live
                </LinkButton>
              </span>
            </div>
          ))}
          {data.visitors > rows.length ? (
            <div className="tabular flex h-10 items-center px-4 text-hint text-fg-meta">
              Showing the {rows.length} most recent of {data.visitors} live visitors
            </div>
          ) : null}
        </div>

        <aside className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
          <Panel>
            <PanelHeader title="Pages right now" description="Visitors per path" />
            <Breakdown
              rows={data.pages.map((page) => ({
                key: page.path,
                label: <span className="font-mono text-mono">{page.path}</span>,
                count: page.count,
              }))}
            />
          </Panel>
          <Panel>
            <PanelHeader title="Where they are" description="Visitors per country" />
            <Breakdown
              rows={data.countries.map((country) => ({
                key: country.code,
                label: (
                  <>
                    <span className="mr-2">{flag(country.code)}</span>
                    {country.name}
                  </>
                ),
                count: country.count,
              }))}
            />
          </Panel>
        </aside>
      </div>
    </Page>
  );
}
