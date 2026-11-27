/**
 * What a public link opens: one recording, or a project's traffic. It is
 * mounted outside the signed-in frame and asks the server for nothing but
 * `/shared/{token}`, so it works with no session at all.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Maximize2, Minimize2 } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { type SharedLink, useSharedLink, useSharedTraffic } from '@/api/analytics';
import { isNotFound } from '@/api/app';
import { api } from '@/api/http';
import type { RecordingEvents } from '@/api/types';
import { day, duration } from '@/lib/format';
import { derive, urlAt } from '@/replay/derive';
import {
  ReplayAddress,
  ReplayControls,
  ReplayStage,
  splitUrl,
  useReplay,
} from '@/replay/stage';
import { Mark, Wordmark } from '@/shell/AppFrame';
import { AuthHeading, AuthLayout } from '@/shell/auth';
import { ErrorNote, Skeleton } from '@/shell/states';
import { IconButton, Page } from '@/ui';
import { TrafficReport } from './Analytics';
import { DaysPicker, useDays } from './analytics/window';

export function Shared() {
  const { token = '' } = useParams();
  const link = useSharedLink(token);

  if (link.isPending) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas px-6">
        <div className="w-full max-w-[340px]" aria-busy="true" aria-label="Loading">
          <div className="mb-8 flex items-center gap-2.5">
            <Mark size={24} />
            <Wordmark height={18} />
          </div>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-3 h-3 w-56" />
        </div>
      </div>
    );
  }

  if (link.isError) {
    return (
      <AuthLayout>
        {isNotFound(link.error) ? (
          <div className="w-full max-w-[340px] animate-swap-in">
            <AuthHeading
              title="This link has expired or was revoked."
              description="Ask whoever shared it with you for a new one."
            />
          </div>
        ) : (
          <ErrorNote error={link.error} onRetry={() => void link.refetch()} />
        )}
      </AuthLayout>
    );
  }

  return link.data.kind === 'recording' ? (
    <SharedRecording token={token} link={link.data} />
  ) : (
    <SharedDashboard token={token} link={link.data} />
  );
}

/** The mark, whose link this is and until when. */
function SharedHeading({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5">
        <Mark size={24} />
        <Wordmark height={18} />
      </div>
      <div className="h-4 w-px shrink-0 bg-line max-sm:hidden" />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-card-title text-fg">{title}</h1>
        <p className="truncate text-hint text-fg-meta">{detail}</p>
      </div>
      {children}
    </>
  );
}

/* --------------------------------------------------------------- Recording */

/**
 * The shared recording's events, fetched the way the player fetches its own:
 * everything first (`after=-1`), then every 2 s whatever came after the last
 * block, for as long as the recording is still live.
 */
function useSharedEvents(token: string) {
  const client = useQueryClient();
  const key = ['shared', token, 'events'] as const;
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<RecordingEvents> => {
      const previous = client.getQueryData<RecordingEvents>(key);
      const next = await api.get<RecordingEvents>(`/shared/${token}/events`, {
        after: previous?.lastSeq ?? -1,
      });
      if (!previous) return next;
      if (next.events.length === 0 && next.complete === previous.complete) return previous;
      return {
        events: next.events.length ? [...previous.events, ...next.events] : previous.events,
        lastSeq: Math.max(previous.lastSeq, next.lastSeq),
        complete: next.complete,
      };
    },
    structuralSharing: false,
    staleTime: (query) => (query.state.data?.complete ? Number.POSITIVE_INFINITY : 0),
    refetchInterval: (query) => (query.state.data?.complete ? false : 2000),
  });
}

function SharedRecording({ token, link }: { token: string; link: SharedLink }) {
  const recording = link.recording;
  const stream = useSharedEvents(token);
  const events = stream.data?.events;
  const data = useMemo(() => derive(events ?? []), [events]);
  // Only where the visitor went is marked: clicks, errors and the rest stay in the dashboard.
  const marks = useMemo(
    () => ({
      durationMs: data.durationMs,
      inactive: data.inactive,
      activity: data.activity.filter((entry) => entry.kind === 'navigate'),
    }),
    [data],
  );
  const live = stream.data ? !stream.data.complete : (recording?.live ?? false);
  const replay = useReplay({
    events,
    data,
    live,
    startMs: link.startMs,
    viewport: recording?.viewport,
  });
  const address = splitUrl(urlAt(data, replay.time), '', '');

  const frame = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === frame.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  return (
    <div className="flex h-full flex-col bg-canvas md:p-2">
      <div
        ref={frame}
        className="flex min-h-0 flex-1 flex-col overflow-hidden border-line bg-panel md:rounded-xl md:border"
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line-subtle px-4">
          <SharedHeading
            title={link.project}
            detail={`Shared recording · expires ${day(link.expiresAt)}`}
          >
            {recording ? (
              <p className="shrink-0 text-hint text-fg-meta max-md:hidden">
                {recording.device} · {recording.browser} · {recording.os} ·{' '}
                <span className="tabular">{duration(recording.durationMs)}</span>
              </p>
            ) : null}
          </SharedHeading>
        </header>
        <ReplayAddress
          host={address.host}
          path={address.path}
          viewport={recording?.viewport ?? ''}
        />
        <ReplayStage
          replay={replay}
          pending={stream.isPending}
          error={stream.data ? null : stream.error}
          onRetry={() => void stream.refetch()}
        />
        <ReplayControls
          replay={replay}
          marks={marks}
          trailing={
            <IconButton
              icon={full ? Minimize2 : Maximize2}
              label={full ? 'Exit full screen' : 'Full screen'}
              onClick={() => {
                if (full) void document.exitFullscreen();
                else void frame.current?.requestFullscreen?.();
              }}
            />
          }
        />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Dashboard */

function SharedDashboard({ token, link }: { token: string; link: SharedLink }) {
  const [days, setDays] = useDays();
  const traffic = useSharedTraffic(token, days, true);

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <Page>
        <header className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-3">
          <SharedHeading
            title={link.project}
            detail={`Shared analytics · expires ${day(link.expiresAt)}`}
          >
            <DaysPicker value={days} onChange={setDays} />
          </SharedHeading>
        </header>
        {traffic.isPending ? (
          <div
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
            aria-busy="true"
            aria-label="Loading"
          >
            {[0, 1, 2, 3].map((index) => (
              <div
                key={index}
                className="min-h-[104px] rounded-xl border border-line bg-surface px-4 py-3.5"
              >
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-4 h-6 w-16" />
              </div>
            ))}
          </div>
        ) : !traffic.data ? (
          <div className="rounded-xl border border-line bg-surface">
            <ErrorNote error={traffic.error} onRetry={() => void traffic.refetch()} />
          </div>
        ) : (
          <TrafficReport traffic={traffic.data} days={days} />
        )}
      </Page>
    </div>
  );
}
