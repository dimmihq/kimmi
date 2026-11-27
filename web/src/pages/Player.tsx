import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  FileX,
  FastForward,
  Flame,
  Globe,
  Keyboard,
  Link2,
  Lock,
  type LucideIcon,
  Maximize2,
  Minimize2,
  Moon,
  MoreHorizontal,
  MousePointerClick,
  MoveVertical,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Star,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { type eventWithTime, Replayer } from 'rrweb';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  isNotFound,
  useDeleteRecording,
  useRecording,
  useRecordingEvents,
  useUpdateRecording,
  visitorLabel,
} from '@/api/app';
import { errorMessage } from '@/api/http';
import type { Project, RecordingDetail } from '@/api/types';
import { bytes, clock, duration, flag } from '@/lib/format';
import {
  type ActivityEntry,
  type ActivityKind,
  type Derived,
  derive,
  urlAt,
} from '@/replay/derive';
import { useProjectScope, useTrail } from '@/shell/AppFrame';
import { ErrorNote, Skeleton } from '@/shell/states';
import {
  cn,
  ConfirmDialog,
  IconButton,
  Menu,
  Segmented,
  Select,
  Switch,
  EmptyState,
  LinkButton,
  Page,
  Tag,
  toast,
  Tooltip,
} from '@/ui';

const KIND: Record<ActivityKind, { icon: LucideIcon; tone: string; mark: string }> = {
  navigate: { icon: Globe, tone: 'text-info-fg', mark: 'bg-info' },
  click: { icon: MousePointerClick, tone: 'text-fg-muted', mark: 'bg-fg-ghost' },
  input: { icon: Keyboard, tone: 'text-fg-muted', mark: 'bg-fg-ghost' },
  scroll: { icon: MoveVertical, tone: 'text-fg-meta', mark: 'bg-fg-ghost' },
  rage: { icon: Flame, tone: 'text-warning-fg', mark: 'bg-warning' },
  dead: { icon: CircleSlash, tone: 'text-warning-fg', mark: 'bg-warning' },
  error: { icon: TriangleAlert, tone: 'text-danger-fg', mark: 'bg-danger' },
  idle: { icon: Moon, tone: 'text-fg-ghost', mark: 'bg-fg-ghost' },
};

type Speed = '1' | '2' | '4' | '8';
type InspectorTab = 'activity' | 'console' | 'network' | 'details';

/** Used until the recording's own Meta event says how big the page was. */
const FALLBACK_VIEWPORT = { width: 1280, height: 800 };

/** "1440 × 900" as numbers. */
function parseViewport(value: string) {
  const [width, height] = value.split('×').map((part) => Number.parseInt(part, 10));
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The address bar's host and path for a URL. */
function splitUrl(href: string | null, fallbackHost: string, fallbackPath: string) {
  if (!href) return { host: fallbackHost, path: fallbackPath };
  try {
    const url = new URL(href);
    return { host: url.host, path: `${url.pathname}${url.search}` };
  } catch {
    return { host: fallbackHost, path: href };
  }
}

/* ---------------------------------------------------------------- Timeline */

function Timeline({
  data,
  time,
  onSeek,
}: {
  data: Pick<Derived, 'durationMs' | 'activity' | 'inactive'>;
  time: number;
  onSeek: (ms: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const total = Math.max(1, data.durationMs);
  const at = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total;
  };
  const percent = (ms: number) => `${(ms / total) * 100}%`;
  const marks = data.activity.filter((entry) => entry.kind !== 'idle' && entry.kind !== 'scroll');

  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(total / 1000)}
      aria-valuenow={Math.round(time / 1000)}
      aria-valuetext={duration(time)}
      className="group relative h-9 cursor-pointer touch-none select-none outline-offset-4"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onSeek(at(event.clientX));
      }}
      onPointerMove={(event) => {
        setHover(at(event.clientX));
        if (event.buttons === 1) onSeek(at(event.clientX));
      }}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') onSeek(Math.min(total, time + 5000));
        if (event.key === 'ArrowLeft') onSeek(Math.max(0, time - 5000));
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-active">
        {data.inactive.map((range) => (
          <span
            key={range.start}
            className="hatch absolute inset-y-0 bg-canvas"
            style={{ left: percent(range.start), width: percent(range.end - range.start) }}
          />
        ))}
        <span className="absolute inset-y-0 left-0 bg-brand" style={{ width: percent(time) }} />
      </div>
      {marks.map((entry, index) => {
        const loud = entry.kind === 'rage' || entry.kind === 'error' || entry.kind === 'dead';
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
            key={index}
            className={cn(
              'absolute -translate-x-1/2 rounded-full',
              KIND[entry.kind].mark,
              loud ? 'top-0.5 h-2.5 w-[3px]' : 'bottom-1 size-[3px] opacity-70',
              entry.kind === 'navigate' && 'bottom-0.5 h-2 w-0.5 opacity-100',
            )}
            style={{ left: percent(entry.t) }}
          />
        );
      })}
      <span
        className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel bg-fg shadow-raised transition-transform group-hover:scale-110"
        style={{ left: percent(time) }}
      />
      {hover !== null ? (
        <span
          className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded-md border border-line-field bg-tooltip px-1.5 py-0.5 font-mono text-mono text-[oklch(0.96_0_0)]"
          style={{ left: percent(hover) }}
        >
          {duration(hover)}
        </span>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- Inspector */

function ActivityList({
  entries,
  time,
  onSeek,
  follow,
}: {
  entries: ActivityEntry[];
  time: number;
  onSeek: (ms: number) => void;
  follow: boolean;
}) {
  let current = -1;
  entries.forEach((entry, index) => {
    if (entry.t <= time + 50) current = index;
  });
  return (
    <ol className="p-1.5">
      {entries.map((entry, index) => {
        const { icon: Icon, tone } = KIND[entry.kind];
        const on = index === current;
        const loud = entry.kind === 'rage' || entry.kind === 'error' || entry.kind === 'dead';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
          <li key={index}>
            <button
              type="button"
              onClick={() => onSeek(entry.t)}
              ref={(node) => {
                if (node && on && follow) node.scrollIntoView({ block: 'nearest' });
              }}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-75',
                on ? 'bg-active' : 'hover:bg-hover',
                entry.t > time + 50 && 'opacity-55',
              )}
            >
              <span className="tabular mt-px w-9 shrink-0 font-mono text-mono text-fg-meta">
                {duration(entry.t)}
              </span>
              <Icon className={cn('mt-0.5 size-3.5 shrink-0', tone)} strokeWidth={2} />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-control',
                    loud ? tone : 'text-fg-secondary',
                    entry.kind === 'navigate' && 'font-mono text-mono text-fg',
                  )}
                >
                  {entry.label}
                </span>
                {entry.detail ? (
                  <span className="block truncate text-hint text-fg-meta">{entry.detail}</span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="px-4 py-10 text-center text-body text-fg-meta">{children}</p>;
}

function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-control text-fg-meta">{label}</dt>
      <dd
        className={cn(
          'min-w-0 truncate text-right text-control text-fg-secondary',
          mono && 'font-mono text-mono',
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ Player */

export function Player() {
  const project = useProjectScope();
  const { recordingId = '' } = useParams();
  const detail = useRecording(project.id, recordingId);
  const entry = detail.data;
  useTrail(entry ? visitorLabel(entry.visitor) : null);

  if (entry) return <PlayerView key={entry.id} project={project} entry={entry} />;
  if (detail.isPending) return <PlayerSkeleton />;
  return (
    <Page>
      {isNotFound(detail.error) ? (
        <EmptyState
          icon={FileX}
          title="Recording not found"
          description="It may have been deleted, or it expired under the project's retention."
          action={<LinkButton to={`/projects/${project.id}/recordings`}>All recordings</LinkButton>}
        />
      ) : (
        <ErrorNote error={detail.error} onRetry={() => void detail.refetch()} />
      )}
    </Page>
  );
}

function PlayerSkeleton() {
  return (
    <div className="flex h-full min-h-[560px] flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line-subtle px-3">
        <Skeleton className="size-[30px] rounded-md" />
        <div className="flex-1">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="mt-1.5 h-3 w-56" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="h-9 shrink-0 border-b border-line-subtle" />
          <div className="relative min-h-[240px] flex-1 bg-stage" />
          <div className="h-[84px] shrink-0 border-t border-line-subtle" />
        </div>
        <aside className="max-h-[42vh] w-full shrink-0 border-t border-line bg-aside lg:max-h-none lg:w-[360px] lg:border-l lg:border-t-0" />
      </div>
    </div>
  );
}

/** The middle of the stage when there is nothing to play yet. */
function StageNote({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">{children}</div>
  );
}

function PlayerView({ project, entry }: { project: Project; entry: RecordingDetail }) {
  const navigate = useNavigate();
  const who = entry.visitor;
  const base = `/projects/${project.id}`;
  const stream = useRecordingEvents(project.id, entry.id);
  const events = stream.data?.events;
  const data = useMemo(() => derive(events ?? []), [events]);
  const live = stream.data ? !stream.data.complete : entry.live;
  const update = useUpdateRecording(project.id, entry.id);
  const remove = useDeleteRecording(project.id);

  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const replayer = useRef<Replayer | null>(null);
  /** How many of `events` the Replayer has been given. */
  const fed = useRef(0);
  /** Playback reached the end of a live recording and waits for more. */
  const atLiveEdge = useRef(false);
  // What the Replayer's callbacks read: always the latest render's values.
  const latest = useRef({ events, data, live });
  useLayoutEffect(() => {
    latest.current = { events, data, live };
  });
  const markedSeen = useRef(entry.seen);

  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>('1');
  const [skip, setSkip] = useState(true);
  const [theater, setTheater] = useState(false);
  const [tab, setTab] = useState<InspectorTab>('activity');
  const [onlyErrors, setOnlyErrors] = useState<'all' | 'errors'>('all');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [resized, setResized] = useState<{ width: number; height: number } | null>(null);
  const { width, height } =
    resized ?? data.viewport ?? parseViewport(entry.viewport) ?? FALLBACK_VIEWPORT;

  const fit = useCallback(() => {
    const box = stage.current;
    const wrapper = root.current?.querySelector<HTMLElement>('.replayer-wrapper');
    if (!box || !wrapper) return;
    const scale = Math.min(box.clientWidth / width, box.clientHeight / height, 1);
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
    wrapper.style.transform = `scale(${scale})`;
    wrapper.style.left = `${(box.clientWidth - width * scale) / 2}px`;
    wrapper.style.top = `${(box.clientHeight - height * scale) / 2}px`;
  }, [width, height]);

  // The Replayer is built once there is something to play, from the events so far.
  useEffect(() => {
    const mount = root.current;
    const initial = latest.current.events;
    if (!mount || !data.playable || !initial) return;
    mount.innerHTML = '';
    const player = new Replayer(initial as unknown as eventWithTime[], {
      root: mount,
      speed: 1,
      skipInactive: true,
      showWarning: false,
      mouseTail: { duration: 500, lineWidth: 2, strokeStyle: 'oklch(0.91 0.18 127)' },
    });
    replayer.current = player;
    fed.current = initial.length;
    const total = latest.current.data.durationMs;
    const requested = Number(new URLSearchParams(window.location.search).get('t') ?? 0) * 1000;
    const start = Math.max(0, Math.min(total, requested || 0));
    player.pause(start);
    setTime(start);
    setPlaying(false);
    player.on('resize', (size) => {
      const next = (size ?? {}) as { width?: number; height?: number };
      if (next.width && next.height) setResized({ width: next.width, height: next.height });
    });
    player.on('finish', () => {
      const end = latest.current.data.durationMs;
      setTime(end);
      if (latest.current.live) atLiveEdge.current = true;
      else setPlaying(false);
    });
    return () => {
      player.destroy();
      mount.innerHTML = '';
      replayer.current = null;
      fed.current = 0;
      atLiveEdge.current = false;
    };
  }, [data.playable]);

  // A live recording grows: hand the new events over, and keep playing if we were at the end.
  useEffect(() => {
    const player = replayer.current;
    if (!player || !events || events.length <= fed.current) return;
    for (const event of events.slice(fed.current)) {
      player.addEvent(event as unknown as eventWithTime);
    }
    fed.current = events.length;
    if (atLiveEdge.current) {
      atLiveEdge.current = false;
      player.play(player.getCurrentTime());
    }
  }, [events]);

  useEffect(() => {
    fit();
  }, [fit, data.playable]);

  useEffect(() => {
    const box = stage.current;
    if (!box) return;
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [fit]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const player = replayer.current;
      if (player) {
        setTime(Math.max(0, Math.min(latest.current.data.durationMs, player.getCurrentTime())));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    replayer.current?.setConfig({ speed: Number(speed), skipInactive: skip });
  }, [speed, skip, data.playable]);

  const seek = useCallback(
    (ms: number) => {
      const to = Math.max(0, Math.min(data.durationMs - 1, ms));
      atLiveEdge.current = false;
      setTime(to);
      if (playing) replayer.current?.play(to);
      else replayer.current?.pause(to);
    },
    [data.durationMs, playing],
  );

  const toggle = useCallback(() => {
    const player = replayer.current;
    if (!player) return;
    if (playing) {
      atLiveEdge.current = false;
      player.pause();
      setPlaying(false);
      return;
    }
    const from = time >= data.durationMs - 200 && !live ? 0 : time;
    player.play(from);
    setPlaying(true);
    if (!markedSeen.current) {
      markedSeen.current = true;
      update.mutate({ seen: true });
    }
  }, [playing, time, data.durationMs, live, update]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, button, [role="dialog"], [role="slider"]')) return;
      if (event.metaKey || event.ctrlKey) return;
      if (event.key === ' ') {
        event.preventDefault();
        toggle();
      } else if (event.key === 'ArrowRight') seek(time + 5000);
      else if (event.key === 'ArrowLeft') seek(time - 5000);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, seek, time]);

  const fallbackHost = project.origin.replace(/^https?:\/\//, '');
  const address = splitUrl(urlAt(data, time), fallbackHost, entry.entry);
  const skipping =
    playing && skip && data.inactive.some((range) => time >= range.start && time < range.end);
  const logs =
    onlyErrors === 'errors' ? data.console.filter((item) => item.level === 'error') : data.console;
  const errorCount = data.console.filter((item) => item.level === 'error').length;
  const starred = update.isPending && update.variables.starred !== undefined
    ? update.variables.starred
    : entry.starred;
  const go = (id: string | null) => {
    if (id) navigate(`${base}/recordings/${id}`);
  };

  return (
    <div className="flex h-full min-h-[560px] flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line-subtle px-3">
        <Tooltip label="All recordings" side="bottom">
          <Link
            to={`${base}/recordings`}
            aria-label="All recordings"
            className="flex size-[30px] items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
          >
            <ArrowLeft className="size-4" />
          </Link>
        </Tooltip>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              to={`${base}/visitors/${who.id}`}
              className="truncate text-card-title text-fg hover:underline"
            >
              {who.name ?? 'Anonymous visitor'}
            </Link>
            {live ? (
              <Tag tone="brand" dot>
                Live
              </Tag>
            ) : null}
          </div>
          <div className="truncate text-hint text-fg-meta">
            {clock(entry.startedAt)} · {who.city}, {who.country}
          </div>
        </div>
        <IconButton
          icon={Star}
          label={starred ? 'Remove star' : 'Star recording'}
          onClick={() =>
            update.mutate(
              { starred: !starred },
              {
                onSuccess: (next) => toast(next.starred ? 'Recording starred' : 'Star removed'),
                onError: (error) => toast(errorMessage(error)),
              },
            )
          }
          className={starred ? '[&_svg]:fill-brand [&_svg]:text-brand' : undefined}
        />
        <IconButton
          icon={Link2}
          label={`Copy link at ${duration(time)}`}
          onClick={() => {
            const url = `${window.location.origin}${base}/recordings/${entry.id}?t=${Math.round(time / 1000)}`;
            void navigator.clipboard?.writeText(url);
            toast(`Link copied at ${duration(time)}`);
          }}
        />
        <div className="mx-0.5 h-4 w-px bg-line max-sm:hidden" />
        <IconButton
          icon={ChevronLeft}
          label="Newer recording"
          disabled={!entry.newerId}
          onClick={() => go(entry.newerId)}
          className="max-sm:hidden"
        />
        <IconButton
          icon={ChevronRight}
          label="Older recording"
          disabled={!entry.olderId}
          onClick={() => go(entry.olderId)}
          className="max-sm:hidden"
        />
        <Menu
          align="end"
          actions={[
            {
              id: 'visitor',
              label: 'Open visitor',
              onSelect: () => navigate(`${base}/visitors/${who.id}`),
            },
            {
              id: 'delete',
              label: 'Delete recording',
              icon: Trash2,
              tone: 'danger',
              separated: true,
              onSelect: () => setConfirmDelete(true),
            },
          ]}
          trigger={
            <button
              type="button"
              aria-label="More"
              className="flex size-[30px] items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
            >
              <MoreHorizontal className="size-4" />
            </button>
          }
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-3.5">
            <Lock className="size-3 text-fg-ghost" />
            <span className="min-w-0 flex-1 truncate font-mono text-mono text-fg-muted">
              {address.host}
              <span className="text-fg">{address.path}</span>
            </span>
            <span className="tabular font-mono text-mono text-fg-ghost">{entry.viewport}</span>
          </div>
          <div ref={stage} className="relative min-h-[240px] flex-1 overflow-hidden bg-stage">
            <div ref={root} className="absolute inset-0" />
            {stream.isPending ? null : !stream.data ? (
              <StageNote>
                <ErrorNote error={stream.error} onRetry={() => void stream.refetch()} />
              </StageNote>
            ) : !data.playable ? (
              <StageNote>
                {live ? (
                  <p role="status" className="flex items-center gap-2 text-control text-fg-meta">
                    <span className="size-1.5 animate-pulse-dot rounded-full bg-brand" />
                    Waiting for the first events
                  </p>
                ) : (
                  <p className="text-body text-fg-meta">
                    This session ended before anything could be recorded.
                  </p>
                )}
              </StageNote>
            ) : null}
            {skipping ? (
              <div className="pointer-events-none absolute left-1/2 top-4 flex -translate-x-1/2 animate-swap-in items-center gap-2 rounded-full border border-line-field bg-tooltip px-3 py-1.5 text-control text-[oklch(0.96_0_0)] shadow-overlay">
                <FastForward className="size-3.5 text-brand" />
                Skipping inactivity
              </div>
            ) : null}
            {data.playable && !playing && time === 0 ? (
              <button
                type="button"
                aria-label="Play recording"
                onClick={toggle}
                className="absolute left-1/2 top-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-brand text-brand-ink shadow-dialog transition-transform hover:scale-105"
              >
                <Play className="ml-1 size-7 fill-current" />
              </button>
            ) : null}
          </div>

          <div className="shrink-0 border-t border-line-subtle px-4 pb-3 pt-2">
            <Timeline data={data} time={time} onSeek={seek} />
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-2">
              <Tooltip label={playing ? 'Pause (space)' : 'Play (space)'}>
                <button
                  type="button"
                  aria-label={playing ? 'Pause' : 'Play'}
                  onClick={toggle}
                  disabled={!data.playable}
                  className="flex size-8 items-center justify-center rounded-full bg-brand text-brand-ink transition-colors hover:bg-brand-hover"
                >
                  {playing ? (
                    <Pause className="size-3.5 fill-current" />
                  ) : (
                    <Play className="ml-0.5 size-3.5 fill-current" />
                  )}
                </button>
              </Tooltip>
              <IconButton icon={RotateCcw} label="Back 10 s" onClick={() => seek(time - 10_000)} />
              <IconButton icon={RotateCw} label="Forward 10 s" onClick={() => seek(time + 10_000)} />
              <span className="tabular ml-1 font-mono text-mono text-fg-secondary">
                {duration(time)}
                <span className="text-fg-ghost"> / {duration(data.durationMs)}</span>
              </span>
              <div className="flex-1" />
              <div className="flex items-center gap-2 text-control text-fg-muted">
                <Switch checked={skip} onChange={setSkip} label="Skip inactivity" />
                <span className="max-sm:hidden">Skip inactivity</span>
              </div>
              <Select
                label="Playback speed"
                size="sm"
                value={speed}
                onChange={setSpeed}
                className="w-[72px]"
                options={[
                  { value: '1', label: '1×' },
                  { value: '2', label: '2×' },
                  { value: '4', label: '4×' },
                  { value: '8', label: '8×' },
                ]}
              />
              <IconButton
                icon={theater ? Minimize2 : Maximize2}
                label={theater ? 'Show inspector' : 'Hide inspector'}
                onClick={() => setTheater((value) => !value)}
                className="max-lg:hidden"
              />
            </div>
          </div>
        </div>

        {theater ? null : (
          <aside className="flex max-h-[42vh] w-full shrink-0 flex-col border-t border-line bg-aside lg:max-h-none lg:w-[360px] lg:border-l lg:border-t-0">
            <div role="tablist" className="flex h-9 shrink-0 items-center gap-4 border-b border-line-subtle px-3.5">
              {(
                [
                  ['activity', 'Activity', data.activity.length],
                  ['console', 'Console', data.console.length],
                  ['network', 'Network', data.network.length],
                  ['details', 'Details', undefined],
                ] as const
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  onClick={() => setTab(value)}
                  className={cn(
                    '-mb-px flex h-9 items-center gap-1.5 border-b-2 text-control transition-colors',
                    tab === value
                      ? 'border-brand text-fg'
                      : 'border-transparent text-fg-meta hover:text-fg-secondary',
                  )}
                >
                  {label}
                  {count !== undefined ? (
                    <span className="tabular text-hint text-fg-ghost">{count}</span>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {tab === 'activity' ? (
                <ActivityList entries={data.activity} time={time} onSeek={seek} follow={playing} />
              ) : null}

              {tab === 'console' ? (
                <>
                  <div className="px-3.5 py-2.5">
                    <Segmented
                      label="Console filter"
                      value={onlyErrors}
                      onChange={setOnlyErrors}
                      options={[
                        { value: 'all', label: 'All' },
                        { value: 'errors', label: `Errors ${errorCount}` },
                      ]}
                    />
                  </div>
                  {logs.length === 0 ? (
                    <Empty>Nothing was logged in this session.</Empty>
                  ) : (
                    <ol className="border-t border-line-subtle">
                      {logs.map((item, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
                        <li key={index}>
                          <button
                            type="button"
                            onClick={() => seek(item.t)}
                            className={cn(
                              'flex w-full gap-2.5 border-b border-line-subtle px-3.5 py-2 text-left hover:bg-hover',
                              item.level === 'error' && 'bg-danger-soft',
                              item.level === 'warn' && 'bg-warning-soft',
                              item.t > time + 50 && 'opacity-55',
                            )}
                          >
                            <span className="tabular mt-px w-9 shrink-0 font-mono text-mono text-fg-meta">
                              {duration(item.t)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span
                                className={cn(
                                  'block break-words font-mono text-mono',
                                  item.level === 'error'
                                    ? 'text-danger-fg'
                                    : item.level === 'warn'
                                      ? 'text-warning-fg'
                                      : 'text-fg-secondary',
                                )}
                              >
                                {item.text}
                              </span>
                              <span className="block font-mono text-[0.65rem] text-fg-ghost">
                                {item.source}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                </>
              ) : null}

              {tab === 'network' ? (
                <ol>
                  {data.network.map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
                    <li key={index}>
                      <button
                        type="button"
                        onClick={() => seek(item.t)}
                        className={cn(
                          'flex w-full items-center gap-2.5 border-b border-line-subtle px-3.5 py-2 text-left hover:bg-hover',
                          item.t > time + 50 && 'opacity-55',
                        )}
                      >
                        <span
                          className={cn(
                            'tabular w-8 shrink-0 font-mono text-mono',
                            item.status >= 400 ? 'text-danger-fg' : 'text-brand-fg',
                          )}
                        >
                          {item.status}
                        </span>
                        <span className="w-9 shrink-0 font-mono text-mono text-fg-meta">
                          {item.method}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-mono text-fg-secondary">
                          {item.url}
                        </span>
                        <span className="tabular shrink-0 font-mono text-mono text-fg-meta">
                          {item.ms} ms
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : null}

              {tab === 'details' ? (
                <div className="px-4 py-3">
                  <h3 className="mb-1 text-label text-fg-ghost">Session</h3>
                  <dl className="mb-5">
                    <Fact label="Recording" mono>
                      {entry.id}
                    </Fact>
                    <Fact label="Started">{clock(entry.startedAt)}</Fact>
                    <Fact label="Duration">{duration(data.durationMs)}</Fact>
                    <Fact label="Pages">{entry.pages}</Fact>
                    <Fact label="Entry page" mono>
                      {entry.entry}
                    </Fact>
                    <Fact label="Referrer">{entry.referrer ?? 'Direct'}</Fact>
                    <Fact label="Release" mono>
                      {entry.release ?? 'Not set'}
                    </Fact>
                    <Fact label="Size on disk">{bytes(entry.sizeBytes)}</Fact>
                  </dl>
                  <h3 className="mb-1 text-label text-fg-ghost">Visitor</h3>
                  <dl className="mb-5">
                    <Fact label="Name">{who.name ?? 'Anonymous'}</Fact>
                    {who.email ? <Fact label="Email">{who.email}</Fact> : null}
                    <Fact label="Visitor ID" mono>
                      {who.id}
                    </Fact>
                    <Fact label="Location">
                      {flag(who.countryCode)} {who.city}, {who.country}
                    </Fact>
                    <Fact label="Sessions">{who.sessions}</Fact>
                  </dl>
                  <h3 className="mb-1 text-label text-fg-ghost">Device</h3>
                  <dl>
                    <Fact label="Device">{who.device}</Fact>
                    <Fact label="Browser">{who.browser}</Fact>
                    <Fact label="OS">{who.os}</Fact>
                    <Fact label="Viewport" mono>
                      {entry.viewport}
                    </Fact>
                  </dl>
                </div>
              ) : null}
            </div>
          </aside>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this recording?"
        description="The recording and everything captured in it are removed for good. This cannot be undone."
        confirmLabel="Delete recording"
        danger
        onConfirm={() =>
          remove.mutate(entry.id, {
            onSuccess: () => {
              toast('Recording deleted');
              navigate(`${base}/recordings`);
            },
            onError: (error) => toast(errorMessage(error)),
          })
        }
      />
    </div>
  );
}
