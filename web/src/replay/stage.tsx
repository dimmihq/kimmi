/**
 * The replay itself: the rrweb player, its stage, the timeline and the
 * controls under it. The dashboard's player and the public shared page both
 * render these, so a shared recording plays exactly as it does signed in.
 */
import {
  CircleSlash,
  FastForward,
  Flame,
  Globe,
  Keyboard,
  Lock,
  type LucideIcon,
  Moon,
  MousePointerClick,
  MoveVertical,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { type eventWithTime, Replayer } from 'rrweb';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { duration } from '@/lib/format';
import { ErrorNote } from '@/shell/states';
import { cn, IconButton, Select, Switch, Tooltip } from '@/ui';
import type { ActivityKind, Derived, RawEvent } from './derive';

export const KIND: Record<ActivityKind, { icon: LucideIcon; tone: string; mark: string }> = {
  navigate: { icon: Globe, tone: 'text-info-fg', mark: 'bg-info' },
  click: { icon: MousePointerClick, tone: 'text-fg-muted', mark: 'bg-fg-ghost' },
  input: { icon: Keyboard, tone: 'text-fg-muted', mark: 'bg-fg-ghost' },
  scroll: { icon: MoveVertical, tone: 'text-fg-meta', mark: 'bg-fg-ghost' },
  rage: { icon: Flame, tone: 'text-warning-fg', mark: 'bg-warning' },
  dead: { icon: CircleSlash, tone: 'text-warning-fg', mark: 'bg-warning' },
  error: { icon: TriangleAlert, tone: 'text-danger-fg', mark: 'bg-danger' },
  track: { icon: Zap, tone: 'text-brand-fg', mark: 'bg-brand' },
  idle: { icon: Moon, tone: 'text-fg-ghost', mark: 'bg-fg-ghost' },
};

export type Speed = '1' | '2' | '4' | '8';

/** Used until the recording's own Meta event says how big the page was. */
const FALLBACK_VIEWPORT = { width: 1280, height: 800 };

/** "1440 × 900" as numbers. */
function parseViewport(value: string) {
  const [width, height] = value.split('×').map((part) => Number.parseInt(part, 10));
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The address bar's host and path for a URL. */
export function splitUrl(href: string | null, fallbackHost: string, fallbackPath: string) {
  if (!href) return { host: fallbackHost, path: fallbackPath };
  try {
    const url = new URL(href);
    return { host: url.host, path: `${url.pathname}${url.search}` };
  } catch {
    return { host: fallbackHost, path: href };
  }
}

/* ---------------------------------------------------------------- Timeline */

export function Timeline({
  data,
  time,
  onSeek,
  notes,
}: {
  data: Pick<Derived, 'durationMs' | 'activity' | 'inactive'>;
  time: number;
  onSeek: (ms: number) => void;
  /** Moments someone left a note at, in ms from the start. */
  notes?: readonly number[];
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const total = Math.max(1, data.durationMs);
  const at = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total;
  };
  const percent = (ms: number) => `${(Math.max(0, Math.min(total, ms)) / total) * 100}%`;
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
      {notes?.map((t, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
          key={index}
          className="absolute top-1 size-[5px] -translate-x-1/2 rounded-full border border-fg-muted bg-panel"
          style={{ left: percent(t) }}
        />
      ))}
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

/* ------------------------------------------------------------------ Replay */

export interface Replay {
  stage: RefObject<HTMLDivElement | null>;
  root: RefObject<HTMLDivElement | null>;
  data: Derived;
  live: boolean;
  /** Milliseconds from the first event. */
  time: number;
  playing: boolean;
  /** Playing through a stretch without input, at speed. */
  skipping: boolean;
  speed: Speed;
  setSpeed: (speed: Speed) => void;
  skip: boolean;
  setSkip: (skip: boolean) => void;
  seek: (ms: number) => void;
  toggle: () => void;
}

/**
 * Plays `events` in the stage this hands back. The Replayer is built once
 * there is something to play and paused at `startMs`; events that arrive
 * later (a live recording) are fed to it as they come.
 */
export function useReplay({
  events,
  data,
  live,
  startMs = 0,
  viewport,
  onPlay,
}: {
  events: readonly RawEvent[] | undefined;
  /** `derive(events)`, computed by the caller so it can show the rest of it. */
  data: Derived;
  /** More events may still arrive. */
  live: boolean;
  startMs?: number;
  /** "1440 × 900", used until the events say how big the page was. */
  viewport?: string;
  /** Called every time playback starts. */
  onPlay?: () => void;
}): Replay {
  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const replayer = useRef<Replayer | null>(null);
  /** How many of `events` the Replayer has been given. */
  const fed = useRef(0);
  /** Playback reached the end of a live recording and waits for more. */
  const atLiveEdge = useRef(false);
  // What the Replayer's callbacks read: always the latest render's values.
  const latest = useRef({ events, data, live, startMs, onPlay });
  useLayoutEffect(() => {
    latest.current = { events, data, live, startMs, onPlay };
  });

  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>('1');
  const [skip, setSkip] = useState(true);
  const [resized, setResized] = useState<{ width: number; height: number } | null>(null);
  const { width, height } =
    resized ?? data.viewport ?? (viewport ? parseViewport(viewport) : null) ?? FALLBACK_VIEWPORT;

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
    const start = Math.max(0, Math.min(total, latest.current.startMs || 0));
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
    latest.current.onPlay?.();
  }, [playing, time, data.durationMs, live]);

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

  const skipping =
    playing && skip && data.inactive.some((range) => time >= range.start && time < range.end);

  return {
    stage,
    root,
    data,
    live,
    time,
    playing,
    skipping,
    speed,
    setSpeed,
    skip,
    setSkip,
    seek,
    toggle,
  };
}

/* ------------------------------------------------------------------- Stage */

/** The strip above the stage: where the page was at this moment. */
export function ReplayAddress({
  host,
  path,
  viewport,
}: {
  host: string;
  path: string;
  viewport: string;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-3.5">
      <Lock className="size-3 text-fg-ghost" />
      <span className="min-w-0 flex-1 truncate font-mono text-mono text-fg-muted">
        {host}
        <span className="text-fg">{path}</span>
      </span>
      <span className="tabular font-mono text-mono text-fg-ghost">{viewport}</span>
    </div>
  );
}

/** The middle of the stage when there is nothing to play yet. */
function StageNote({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">{children}</div>
  );
}

/** Where the recording plays, with what to say while there is nothing to play. */
export function ReplayStage({
  replay,
  pending,
  error,
  onRetry,
}: {
  replay: Replay;
  /** The events are still loading. */
  pending: boolean;
  /** Why the events failed to load, when they did. */
  error: unknown;
  onRetry: () => void;
}) {
  const { data, live, playing, time } = replay;
  return (
    <div ref={replay.stage} className="relative min-h-[240px] flex-1 overflow-hidden bg-stage">
      <div ref={replay.root} className="absolute inset-0" />
      {pending ? null : error ? (
        <StageNote>
          <ErrorNote error={error} onRetry={onRetry} />
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
      {replay.skipping ? (
        <div className="pointer-events-none absolute left-1/2 top-4 flex -translate-x-1/2 animate-swap-in items-center gap-2 rounded-full border border-line-field bg-tooltip px-3 py-1.5 text-control text-[oklch(0.96_0_0)] shadow-overlay">
          <FastForward className="size-3.5 text-brand" />
          Skipping inactivity
        </div>
      ) : null}
      {data.playable && !playing && time === 0 ? (
        <button
          type="button"
          aria-label="Play recording"
          onClick={replay.toggle}
          className="absolute left-1/2 top-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-brand text-brand-ink shadow-dialog transition-transform hover:scale-105"
        >
          <Play className="ml-1 size-7 fill-current" />
        </button>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Controls */

/** The timeline and the row of controls under the stage. */
export function ReplayControls({
  replay,
  marks,
  notes,
  trailing,
}: {
  replay: Replay;
  /** What the timeline marks; all of the recording's activity when left out. */
  marks?: Pick<Derived, 'durationMs' | 'activity' | 'inactive'>;
  notes?: readonly number[];
  /** The last control of the row: hide the inspector, go full screen. */
  trailing?: ReactNode;
}) {
  const { data, time, playing, seek } = replay;
  return (
    <div className="shrink-0 border-t border-line-subtle px-4 pb-3 pt-2">
      <Timeline data={marks ?? data} time={time} onSeek={seek} notes={notes} />
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-2">
        <Tooltip label={playing ? 'Pause (space)' : 'Play (space)'}>
          <button
            type="button"
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={replay.toggle}
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
          <Switch checked={replay.skip} onChange={replay.setSkip} label="Skip inactivity" />
          <span className="max-sm:hidden">Skip inactivity</span>
        </div>
        <Select
          label="Playback speed"
          size="sm"
          value={replay.speed}
          onChange={replay.setSpeed}
          className="w-[72px]"
          options={[
            { value: '1', label: '1×' },
            { value: '2', label: '2×' },
            { value: '4', label: '4×' },
            { value: '8', label: '8×' },
          ]}
        />
        {trailing}
      </div>
    </div>
  );
}
