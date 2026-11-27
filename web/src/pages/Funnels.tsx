import { Filter } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  type Days,
  type Funnel,
  type FunnelStep,
  recordingsHref,
  useFunnelDropoffs,
  useFunnels,
} from '@/api/analytics';
import { visitorLabel } from '@/api/app';
import type { Recording } from '@/api/types';
import { ago, duration } from '@/lib/format';
import { ErrorNote, Skeleton, SkeletonRows } from '@/shell/states';
import {
  Avatar,
  Button,
  cn,
  EmptyState,
  LinkButton,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Tag,
} from '@/ui';
import { DaysPicker, useDays } from './analytics/window';

const count = (value: number) => value.toLocaleString();

const percent = (part: number, whole: number) =>
  `${whole > 0 ? ((part / whole) * 100).toFixed(1) : '0.0'}%`;

/** The recordings a step's number stands for; null when the list cannot filter to it. */
function stepHref(projectId: string, step: FunnelStep) {
  if (step.kind === 'event') return recordingsHref(projectId, { event: `track:${step.value}` });
  return step.value.endsWith('*') ? null : recordingsHref(projectId, { path: step.value });
}

function DropoffRow({ entry, projectId }: { entry: Recording; projectId: string }) {
  const who = entry.visitor;
  return (
    <Link
      to={`/projects/${projectId}/recordings/${entry.id}`}
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
      <span className="hidden min-w-0 flex-[1.4] truncate font-mono text-mono text-fg-muted md:block">
        {entry.entry}
      </span>
      <span className="tabular w-16 shrink-0 text-right font-mono text-mono text-fg-secondary">
        {duration(entry.durationMs)}
      </span>
      <span className="tabular w-20 shrink-0 text-right text-control text-fg-meta">
        {entry.live ? (
          <Tag tone="brand" dot>
            Live
          </Tag>
        ) : (
          ago(entry.startedAt)
        )}
      </span>
    </Link>
  );
}

/** The recordings of visits that stopped after one step, opened under it. */
function Dropoffs({
  projectId,
  funnelId,
  step,
  days,
  dropped,
  id,
}: {
  projectId: string;
  funnelId: string;
  step: number;
  days: Days;
  dropped: number;
  id: string;
}) {
  const list = useFunnelDropoffs(projectId, funnelId, step, days, true);
  const items = list.data?.items;
  return (
    <div id={id} className="border-y border-line-subtle bg-hover">
      {list.isPending ? (
        <SkeletonRows count={Math.min(3, Math.max(1, dropped))} />
      ) : !items ? (
        <ErrorNote className="py-6" error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <p className="px-4 py-6 text-center text-body text-fg-meta">
          None of the visits that stopped here was recorded.
        </p>
      ) : (
        <>
          {items.map((entry) => (
            <DropoffRow key={entry.id} entry={entry} projectId={projectId} />
          ))}
          {items.length < dropped ? (
            <p className="tabular border-t border-line-subtle px-4 py-2 text-hint text-fg-meta">
              {count(items.length)} of {count(dropped)} visits that stopped here were recorded
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function StepRow({
  projectId,
  step,
  index,
  first,
}: {
  projectId: string;
  step: FunnelStep;
  index: number;
  first: number;
}) {
  const share = first > 0 ? Math.min(1, step.visits / first) : 0;
  const href = stepHref(projectId, step);
  return (
    <div className="relative flex items-center gap-3 px-4 py-2">
      <span
        className="absolute inset-y-1 left-2 rounded-md bg-selected"
        style={{ width: `calc(${share * 100}% - 16px)` }}
      />
      <span className="tabular relative w-4 shrink-0 font-mono text-mono text-fg-ghost">
        {index + 1}
      </span>
      <span className="relative flex min-w-0 flex-1 items-center gap-2">
        <span
          className={cn(
            'truncate text-control text-fg-secondary',
            step.kind === 'page' && 'font-mono text-mono',
          )}
        >
          {step.value}
        </span>
        {step.kind === 'event' ? <Tag>event</Tag> : null}
      </span>
      {href ? (
        <Link
          to={href}
          aria-label={`${count(step.visits)} visits, open their recordings`}
          className="tabular relative w-16 shrink-0 text-right text-control text-fg hover:underline"
        >
          {count(step.visits)}
        </Link>
      ) : (
        <span className="tabular relative w-16 shrink-0 text-right text-control text-fg">
          {count(step.visits)}
        </span>
      )}
      <span className="tabular relative w-14 shrink-0 text-right text-control text-fg-meta">
        {percent(step.visits, first)}
      </span>
    </div>
  );
}

function FunnelPanel({ projectId, funnel, days }: { projectId: string; funnel: Funnel; days: Days }) {
  /** The step whose drop-offs are open, if any. */
  const [open, setOpen] = useState<number | null>(null);
  const { steps } = funnel;
  const first = steps[0]?.visits ?? 0;
  const last = steps[steps.length - 1]?.visits ?? 0;

  return (
    <Panel className="overflow-hidden pb-2">
      <PanelHeader
        title={funnel.name}
        description={
          first > 0
            ? `${steps.length} steps · ${count(first)} visits started`
            : 'No visit reached the first step in this window.'
        }
        action={
          <div className="text-right">
            <div className="tabular text-numeric text-fg">{percent(last, first)}</div>
            <div className="text-hint text-fg-meta">converted</div>
          </div>
        }
      />
      {steps.map((step, index) => {
        const region = `dropoffs-${funnel.id}-${index}`;
        const on = open === index;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps are ordered and may repeat
          <Fragment key={index}>
            <StepRow projectId={projectId} step={step} index={index} first={first} />
            {index < steps.length - 1 ? (
              <div className="flex h-7 items-center gap-2 pl-11 pr-4 text-hint text-fg-meta">
                <span className="tabular">
                  {count(step.dropped)} dropped ({percent(step.dropped, step.visits)})
                </span>
                {step.watchable > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={on}
                    aria-controls={region}
                    onClick={() => setOpen(on ? null : index)}
                    className="h-6 px-1.5 text-hint"
                  >
                    {on ? 'Hide' : 'Watch'}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {on ? (
              <Dropoffs
                id={region}
                projectId={projectId}
                funnelId={funnel.id}
                step={index}
                days={days}
                dropped={step.dropped}
              />
            ) : null}
          </Fragment>
        );
      })}
    </Panel>
  );
}

function FunnelSkeleton() {
  return (
    <Panel className="pb-2">
      <header className="px-4 pb-3 pt-3.5">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="mt-2 h-3 w-56" />
      </header>
      <div aria-busy="true" aria-label="Loading">
        {Array.from({ length: 4 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
          <div key={index} className="flex items-center gap-3 px-4 py-2.5">
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-10" />
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function Funnels() {
  const { projectId = '' } = useParams();
  const [days, setDays] = useDays();
  const funnels = useFunnels(projectId, days);
  const data = funnels.data;
  const settings = `/projects/${projectId}/settings/analytics`;

  return (
    <Page>
      <PageHeader
        title="Funnels"
        description="How many visits get through each step, and where the rest stop"
        actions={
          <>
            {data && data.length > 0 ? <LinkButton to={settings}>Edit funnels</LinkButton> : null}
            <DaysPicker value={days} onChange={setDays} />
          </>
        }
      />

      {funnels.isPending ? (
        <div className="grid gap-3">
          <FunnelSkeleton />
          <FunnelSkeleton />
        </div>
      ) : !data ? (
        <Panel>
          <ErrorNote error={funnels.error} onRetry={() => void funnels.refetch()} />
        </Panel>
      ) : data.length === 0 ? (
        <Panel>
          <EmptyState
            icon={Filter}
            title="No funnels yet"
            description="A funnel is 2 to 6 pages or events in order. Define one in the project settings to see how many visits get through each step."
            action={
              <LinkButton to={settings} variant="primary">
                Add a funnel
              </LinkButton>
            }
          />
        </Panel>
      ) : (
        <div className="grid gap-3">
          {data.map((funnel) => (
            <FunnelPanel
              key={`${funnel.id}:${days}`}
              projectId={projectId}
              funnel={funnel}
              days={days}
            />
          ))}
        </div>
      )}
    </Page>
  );
}
