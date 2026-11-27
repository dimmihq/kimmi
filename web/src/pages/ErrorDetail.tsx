import { Play, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { type ErrorDetail as ErrorData, type Occurrence, recordingsHref, useErrorGroup } from '@/api/analytics';
import { isNotFound } from '@/api/app';
import { ago, clock, compact } from '@/lib/format';
import { useTrail } from '@/shell/AppFrame';
import { ErrorNote, Skeleton, SkeletonRows } from '@/shell/states';
import {
  CodeBlock,
  EmptyState,
  Figure,
  LinkButton,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
} from '@/ui';
import { DaysPicker, useDays } from './analytics/window';

/** What the SDK sent with an error; anything unreadable counts as nothing. */
function errorProps(text: string): { source: string; stack: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object') {
      const { source, stack } = value as { source?: unknown; stack?: unknown };
      return {
        source: typeof source === 'string' ? source : '',
        stack: typeof stack === 'string' ? stack : '',
      };
    }
  } catch {
    // Not JSON: there is no stack to show.
  }
  return { source: '', stack: '' };
}

/** One very long line, or bundle names that only a build step writes. */
function looksMinified(stack: string) {
  const lines = stack.split('\n');
  return (
    (lines.length === 1 && stack.length > 300) ||
    lines.some((line) => line.length > 500) ||
    /\.min\.|[.-][0-9a-f]{8,}\.(?:m?js|cjs)/i.test(stack)
  );
}

/** The recording of an occurrence, opened five seconds before it. */
const watchHref = (projectId: string, entry: Occurrence) =>
  `/projects/${projectId}/recordings/${entry.visitId}?t=${Math.max(0, Math.floor((entry.ts - entry.startedAt) / 1000) - 5)}`;

export function ErrorDetail() {
  const { projectId = '', fingerprint = '' } = useParams();
  const [days, setDays] = useDays();
  const detail = useErrorGroup(projectId, fingerprint, days);
  const data = detail.data;
  useTrail(data ? data.group.message : null, true);

  const errorsHref = `/projects/${projectId}/errors${days === 7 ? '' : `?days=${days}`}`;
  const picker = <DaysPicker value={days} onChange={setDays} />;

  if (data) {
    return <ErrorView projectId={projectId} data={data} picker={picker} />;
  }
  if (detail.isPending) {
    return (
      <Page>
        <header className="mb-6">
          <Skeleton className="h-6 w-96 max-w-full" />
          <Skeleton className="mt-2.5 h-3 w-64" />
        </header>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {['a', 'b', 'c', 'd'].map((key) => (
            <Panel key={key} className="flex min-h-[104px] flex-col px-4 py-3.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-6 w-14" />
            </Panel>
          ))}
        </div>
        <Panel className="mt-3 overflow-hidden">
          <SkeletonRows count={5} />
        </Panel>
      </Page>
    );
  }
  if (isNotFound(detail.error)) {
    return (
      <Page>
        <PageHeader title="Error" actions={picker} />
        <EmptyState
          icon={SearchX}
          title="Error not found"
          description="It did not happen in this window, or the visits it happened in are no longer kept."
          action={<LinkButton to={errorsHref}>All errors</LinkButton>}
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

function ErrorView({
  projectId,
  data,
  picker,
}: {
  projectId: string;
  data: ErrorData;
  picker: ReactNode;
}) {
  const { group, occurrences } = data;
  const latest = occurrences.reduce<Occurrence | null>(
    (best, entry) => (best && best.ts >= entry.ts ? best : entry),
    null,
  );
  const props = errorProps(latest?.props ?? '');
  const source = props.source || group.source;

  return (
    <Page>
      <PageHeader
        title={<span className="block break-words font-mono text-title">{group.message}</span>}
        description={
          <span className="font-mono text-mono">
            {[group.source, group.path].filter(Boolean).join(' · ')}
          </span>
        }
        actions={
          <>
            {picker}
            <LinkButton to={recordingsHref(projectId, { event: `error:${group.fingerprint}` })}>
              All recordings
            </LinkButton>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Figure label="Visits affected" value={compact(group.visits)} detail="In this window" />
        <Figure label="Occurrences" value={compact(group.count)} detail="In this window" />
        <Figure label="First seen" value={ago(group.firstSeen)} detail={clock(group.firstSeen)} />
        <Figure label="Last seen" value={ago(group.lastSeen)} detail={clock(group.lastSeen)} />
      </div>

      <Panel className="mt-3">
        <PanelHeader title="Stack" description="From the latest occurrence" />
        <div className="px-4 pb-4">
          {props.stack ? (
            <>
              <CodeBlock code={props.stack} label={source} />
              {looksMinified(props.stack) ? (
                <p className="mt-2 text-hint text-fg-meta">
                  Stack traces come from the browser as shipped; source maps are not applied.
                </p>
              ) : null}
            </>
          ) : (
            <p className="py-6 text-center text-body text-fg-meta">
              The browser sent no stack with this error.
            </p>
          )}
        </div>
      </Panel>

      <Panel className="mt-3 overflow-hidden">
        <PanelHeader title="Occurrences" description="Latest first, with the recording when there is one" />
        <div className="flex h-[38px] items-center gap-4 border-y border-line-subtle px-4 text-label text-fg-meta">
          <span className="w-28 shrink-0">Time</span>
          <span className="min-w-0 flex-1">Page</span>
          <span className="hidden w-44 shrink-0 md:block">Browser</span>
          <span className="hidden w-28 shrink-0 lg:block">Release</span>
          <span className="w-24 shrink-0 text-right">Recording</span>
        </div>
        {occurrences.length === 0 ? (
          <p className="px-4 py-10 text-center text-body text-fg-meta">
            No occurrence of this error is kept in this window.
          </p>
        ) : (
          occurrences.map((entry) => (
            <div
              key={`${entry.visitId}:${entry.ts}`}
              className="flex h-12 items-center gap-4 border-b border-line-subtle px-4 last:border-b-0"
            >
              <span className="tabular w-28 shrink-0 text-control text-fg">{clock(entry.ts)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-mono text-fg-muted">
                {entry.path}
              </span>
              <span className="hidden w-44 shrink-0 truncate text-control text-fg-muted md:block">
                {[entry.browser, entry.os].filter(Boolean).join(' · ')}
              </span>
              <span className="hidden w-28 shrink-0 truncate font-mono text-mono text-fg-muted lg:block">
                {entry.release || <span className="text-fg-ghost">None</span>}
              </span>
              <span className="flex w-24 shrink-0 justify-end">
                {entry.recorded ? (
                  <LinkButton size="sm" icon={Play} to={watchHref(projectId, entry)}>
                    Watch
                  </LinkButton>
                ) : (
                  <span className="text-hint text-fg-ghost">Not recorded</span>
                )}
              </span>
            </div>
          ))
        )}
      </Panel>
    </Page>
  );
}
