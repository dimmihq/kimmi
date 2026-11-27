/** The small pieces of the traffic report: ranked rows, their placeholders, the day chart. */
import { PlayCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { compact } from '@/lib/format';
import { Skeleton } from '@/shell/states';
import { cn, Panel, Tooltip } from '@/ui';

/** The quiet trailing link of a row: the recordings behind its number. */
export function WatchLink({ to, about }: { to: string; about: string }) {
  return (
    <Tooltip label="Watch recordings">
      <Link
        to={to}
        aria-label={`Watch recordings of ${about}`}
        className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg-ghost transition-colors duration-100 hover:bg-active hover:text-fg"
      >
        <PlayCircle className="size-3.5" strokeWidth={1.9} />
      </Link>
    </Tooltip>
  );
}

export interface Rank {
  /** The raw value, used as the filter; empty when the row cannot be filtered by. */
  name: string;
  label: string;
  count: number;
  detail?: ReactNode;
}

/**
 * One row of a ranked list, with its share drawn behind it. With `onPick` the
 * whole row is a button; `href` adds the link to the matching recordings.
 */
export function RankRow({
  row,
  share,
  mono,
  active,
  onPick,
  href,
}: {
  row: Rank;
  share: number;
  mono?: boolean;
  active?: boolean;
  onPick?: () => void;
  href?: string;
}) {
  const text = cn(
    'min-w-0 flex-1 truncate text-left text-control',
    active ? 'font-medium text-fg' : 'text-fg-secondary',
    mono && 'font-mono text-mono',
  );
  return (
    <div
      className={cn(
        'relative flex items-center gap-3 px-4 py-2',
        onPick && 'transition-colors duration-75 hover:bg-hover',
      )}
    >
      <span
        className="absolute inset-y-1 left-2 rounded-md bg-selected"
        style={{ width: `calc(${Math.min(1, share) * 100}% - 16px)` }}
      />
      {onPick ? (
        <button
          type="button"
          aria-pressed={Boolean(active)}
          onClick={onPick}
          className={cn(text, 'after:absolute after:inset-0')}
        >
          <span className="relative">{row.label}</span>
        </button>
      ) : (
        <span className={cn(text, 'relative')}>{row.label}</span>
      )}
      {row.detail ? (
        <span className="tabular pointer-events-none relative shrink-0 text-hint text-fg-meta">
          {row.detail}
        </span>
      ) : null}
      <span className="tabular pointer-events-none relative w-12 shrink-0 text-right text-control text-fg">
        {compact(row.count)}
      </span>
      {href ? <WatchLink to={href} about={row.label} /> : null}
    </div>
  );
}

export function RankSkeleton({ rows }: { rows: number }) {
  return (
    <div aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
        <div key={index} className="flex items-center gap-3 px-4 py-2">
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-8" />
        </div>
      ))}
    </div>
  );
}

export function FigureSkeleton() {
  return (
    <Panel className="flex min-h-[104px] flex-col px-4 py-3.5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-6 w-20" />
      <Skeleton className="mt-2.5 h-3 w-28" />
    </Panel>
  );
}

/** The line a panel shows when its list is empty. */
export function Quiet({ children }: { children: ReactNode }) {
  return <p className="px-4 py-10 text-center text-body text-fg-meta">{children}</p>;
}

export interface ChartDay {
  label: string;
  visitors: number;
  visits: number;
  pageviews: number;
}

/** Visitors per day, drawn like the recordings chart of the overview. */
export function VisitorsChart({ days }: { days: ChartDay[] }) {
  const max = Math.max(1, ...days.map((day) => day.visitors));
  const ticks = [1, 0.5, 0];
  return (
    <div className="px-4 pb-4">
      <div className="flex gap-3">
        <div className="flex h-56 flex-col justify-between py-0 text-right font-mono text-[0.65rem] text-fg-ghost">
          {ticks.map((tick) => (
            <span key={tick} className="tabular -translate-y-1/2 first:translate-y-0 last:translate-y-0">
              {compact(Math.round(max * tick))}
            </span>
          ))}
        </div>
        <div className="relative h-56 flex-1">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute inset-x-0 border-t border-dashed border-line-subtle"
              style={{ top: `${(1 - tick) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 flex items-end gap-[3px]">
            {days.map((day) => (
              <Tooltip
                key={day.label}
                label={
                  <span className="block text-left">
                    <span className="block font-semibold">{day.label}</span>
                    <span className="tabular block opacity-80">
                      {compact(day.visitors)} visitors · {compact(day.visits)} visits ·{' '}
                      {compact(day.pageviews)} page views
                    </span>
                  </span>
                }
              >
                <div
                  className="flex-1 rounded-t-[2px] bg-brand transition-opacity hover:opacity-80"
                  style={{ height: `${(day.visitors / max) * 100}%` }}
                />
              </Tooltip>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex justify-between pl-9 font-mono text-[0.65rem] text-fg-ghost">
        <span>{days[0]?.label}</span>
        {days.length > 2 ? <span>{days[Math.floor(days.length / 2)]?.label}</span> : null}
        {days.length > 1 ? <span>{days[days.length - 1]?.label}</span> : null}
      </div>
    </div>
  );
}
