import { ChevronRight, Trash2, UserX } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { isNotFound, useDeleteVisitor, useVisitor, visitorLabel } from '@/api/app';
import { errorMessage } from '@/api/http';
import type { Project, VisitorDetail as VisitorData } from '@/api/types';
import { ago, clock, duration, flag } from '@/lib/format';
import { useProjectScope, useTrail } from '@/shell/AppFrame';
import { ErrorNote, Skeleton, SkeletonRows } from '@/shell/states';
import {
  Avatar,
  Button,
  cn,
  ConfirmDialog,
  EmptyState,
  Figure,
  LinkButton,
  Page,
  Panel,
  Tag,
  toast,
} from '@/ui';

const WEEKS = 12;
const HEAT = ['bg-active', 'bg-fg-disabled', 'bg-fg-meta', 'bg-fg-secondary'];

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="shrink-0 text-control text-fg-meta">{label}</dt>
      <dd className="min-w-0 truncate text-right text-control text-fg-secondary">{children}</dd>
    </div>
  );
}

export function VisitorDetail() {
  const current = useProjectScope();
  const { visitorId = '' } = useParams();
  const detail = useVisitor(current.id, visitorId);
  const data = detail.data;
  useTrail(data ? visitorLabel(data.visitor) : null, data ? !data.visitor.name : false);

  if (data) return <VisitorView current={current} data={data} />;
  if (detail.isPending) return <VisitorSkeleton />;
  if (isNotFound(detail.error)) {
    return (
      <Page>
        <EmptyState
          icon={UserX}
          title="Visitor not found"
          description="Their data may have been deleted, or they never visited this project."
          action={<LinkButton to={`/projects/${current.id}/visitors`}>All visitors</LinkButton>}
        />
      </Page>
    );
  }
  return (
    <Page>
      <Panel>
        <ErrorNote error={detail.error} onRetry={() => void detail.refetch()} />
      </Panel>
    </Page>
  );
}

function VisitorSkeleton() {
  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      <div className="min-w-0 flex-1 px-4 pb-16 pt-6 md:px-7">
        <header className="mb-6 flex items-center gap-4">
          <Skeleton className="size-12 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="mt-2 h-3 w-64" />
          </div>
        </header>
        <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
          {['a', 'b', 'c', 'd'].map((key) => (
            <Panel key={key} className="flex min-h-[104px] flex-col px-4 py-3.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-6 w-14" />
            </Panel>
          ))}
        </div>
        <Skeleton className="mb-3 h-4 w-24" />
        <Skeleton className="mb-6 h-[132px] w-full rounded-xl" />
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <SkeletonRows count={4} />
        </div>
      </div>
      <aside className="shrink-0 border-t border-line bg-aside px-4 py-6 md:px-5 lg:w-80 lg:border-l lg:border-t-0">
        <Skeleton className="mb-4 h-4 w-24" />
        {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
          <Skeleton key={key} className="my-3.5 h-3 w-full" />
        ))}
      </aside>
    </div>
  );
}

function VisitorView({ current, data }: { current: Project; data: VisitorData }) {
  const navigate = useNavigate();
  const remove = useDeleteVisitor(current.id);
  const { visitor: who, stats, recordings } = data;
  const label = visitorLabel(who);
  const [deleting, setDeleting] = useState(false);
  const days = data.activity;
  const activeDays = days.filter((day) => day.count > 0).length;

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      <div className="min-w-0 flex-1 px-4 pb-16 pt-6 md:px-7">
        <header className="mb-6 flex flex-wrap items-center gap-4">
          <Avatar name={label} size={48} />
          <div className="min-w-0 flex-1">
            <h1 className={cn('truncate text-fg', who.name ? 'text-page-title' : 'font-mono text-title')}>
              {label}
            </h1>
            <p className="mt-1 truncate text-body text-fg-muted">
              {who.email ?? 'Anonymous visitor. No identify call has named them yet.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag>
              <span>{flag(who.countryCode)}</span>
              {who.country}
            </Tag>
          </div>
        </header>

        <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Figure label="Sessions" value={stats.sessions} detail={`First ${ago(who.firstSeen)}`} />
          <Figure
            label="Total recorded time"
            value={duration(stats.totalDurationMs)}
            detail={`Across ${stats.sessions} ${stats.sessions === 1 ? 'recording' : 'recordings'}`}
          />
          <Figure label="Rage clicks" value={stats.rageClicks} detail="Repeated clicks on one spot" />
          <Figure label="Errors" value={stats.errors} detail="Uncaught in the browser" />
        </div>

        <section className="mb-6">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-card-title text-fg">Activity</h2>
              <p className="mt-0.5 text-hint text-fg-meta">
                Sessions per day over the last 12 weeks · active on {activeDays} days
              </p>
            </div>
            <div className="hidden items-center gap-1.5 text-hint text-fg-meta sm:flex">
              Less
              {HEAT.map((tone) => (
                <span key={tone} className={cn('size-2.5 rounded-[2px]', tone)} />
              ))}
              More
            </div>
          </div>
          <div className="rounded-xl border border-line bg-surface p-4">
            <div
              className="grid grid-flow-col grid-rows-7 gap-[3px]"
              style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}
              role="img"
              aria-label={`Active on ${activeDays} of the last ${days.length} days`}
            >
              {days.map((day) => (
                <span
                  key={day.date}
                  title={`${day.count === 1 ? '1 session' : `${day.count} sessions`} on ${day.date}`}
                  className={cn('h-3 rounded-[2px]', HEAT[Math.min(day.count, HEAT.length - 1)])}
                />
              ))}
            </div>
            <div className="mt-2 flex justify-between text-hint text-fg-ghost">
              <span>12 weeks ago</span>
              <span>This week</span>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-card-title text-fg">Recordings</h2>
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex h-[38px] items-center gap-4 border-b border-line-subtle px-4 text-label text-fg-meta">
              <span className="w-28">Started</span>
              <span className="w-14 text-right">Duration</span>
              <span className="hidden min-w-0 flex-1 sm:block">Entry and exit</span>
              <span className="flex-1 text-right sm:w-40 sm:flex-none">Signals</span>
              <span className="w-4" />
            </div>
            {recordings.length === 0 ? (
              <p className="px-4 py-10 text-center text-body text-fg-meta">
                No recordings of this visitor are kept any more.
              </p>
            ) : null}
            {recordings.map((entry) => (
              <Link
                key={entry.id}
                to={`/projects/${current.id}/recordings/${entry.id}`}
                className="flex h-12 items-center gap-4 border-b border-line-subtle px-4 last:border-b-0 hover:bg-hover"
              >
                <span className="tabular w-28 text-control text-fg">{clock(entry.startedAt)}</span>
                <span className="tabular w-14 text-right text-control text-fg-secondary">
                  {duration(entry.durationMs)}
                </span>
                <span className="hidden min-w-0 flex-1 truncate font-mono text-mono text-fg-muted sm:block">
                  {entry.entry} <span className="text-fg-ghost">→</span> {entry.exit}
                </span>
                <span className="flex flex-1 justify-end gap-1.5 sm:w-40 sm:flex-none">
                  {entry.live ? (
                    <Tag tone="brand" dot>
                      Live
                    </Tag>
                  ) : null}
                  {entry.rageClicks > 0 ? (
                    <Tag tone="warning">{entry.rageClicks} rage</Tag>
                  ) : null}
                  {entry.errors > 0 ? (
                    <Tag tone="danger">
                      {entry.errors} {entry.errors === 1 ? 'error' : 'errors'}
                    </Tag>
                  ) : null}
                </span>
                <ChevronRight className="size-4 text-fg-ghost" />
              </Link>
            ))}
          </div>
        </section>
      </div>

      <aside className="shrink-0 border-t border-line bg-aside px-4 py-6 md:px-5 lg:w-80 lg:border-l lg:border-t-0">
        <h2 className="mb-2 text-card-title text-fg">Properties</h2>
        <dl className="divide-y divide-line-subtle">
          <Property label="Visitor id">
            <span className="font-mono text-mono">{who.id}</span>
          </Property>
          <Property label="First seen">{clock(who.firstSeen)}</Property>
          <Property label="Last seen">{ago(who.lastSeen)}</Property>
          <Property label="Location">
            <span className="mr-1.5">{flag(who.countryCode)}</span>
            {who.city}, {who.country}
          </Property>
          <Property label="Device">{who.device}</Property>
          <Property label="Browser">{who.browser}</Property>
          <Property label="OS">{who.os}</Property>
          <Property label="External id">
            {who.externalId ? <span className="font-mono text-mono">{who.externalId}</span> : 'Not set'}
          </Property>
        </dl>

        <h2 className="mb-1 mt-8 text-card-title text-danger-fg">Delete visitor data</h2>
        <p className="mb-3 text-hint text-fg-meta">
          Removes every recording and property stored for this visitor in {current.name}. Use it
          to answer an erasure request.
        </p>
        <Button
          variant="danger"
          icon={Trash2}
          disabled={remove.isPending}
          onClick={() => setDeleting(true)}
        >
          Delete visitor data
        </Button>
      </aside>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete visitor data"
        description={`${stats.sessions} ${stats.sessions === 1 ? 'session' : 'sessions'} and every property of ${label} are deleted from ${current.name}. This cannot be undone.`}
        confirmLabel="Delete visitor data"
        danger
        onConfirm={() =>
          remove.mutate(who.id, {
            onSuccess: () => {
              toast('Visitor data deleted');
              navigate(`/projects/${current.id}/visitors`);
            },
            onError: (error) => toast(errorMessage(error)),
          })
        }
      />
    </div>
  );
}
