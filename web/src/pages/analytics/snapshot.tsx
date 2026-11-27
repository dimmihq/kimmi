/**
 * A page as visitors saw it, to draw a heatmap on: one moment of a recording,
 * laid out at its recorded width and at the full height of the page, scaled
 * down to the width there is. Nothing in it plays or takes input.
 */
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
import { useRecordingEvents } from '@/api/app';
import { derive } from '@/replay/derive';
import { ErrorNote } from '@/shell/states';

/** The drawn page: its size in page pixels and how far it is scaled down. */
export interface SnapshotStage {
  width: number;
  height: number;
  /** CSS pixels per page pixel, at most 1. */
  scale: number;
  /** The recorded viewport height: where the fold was. Null on a blank page. */
  viewportHeight: number | null;
}

interface SnapshotProps {
  projectId: string;
  /** Null when no recording shows this page: a blank sheet is drawn. */
  recordingId: string | null;
  /** The moment the page was on screen (Unix ms). */
  ts: number;
  /** The heatmap's median viewport width and page height, in pixels. */
  width: number;
  height: number;
  /** Called with the stage once it is measured, and again whenever it changes. */
  onReady: (stage: SnapshotStage) => void;
  /** Drawn over the page, in the same scaled box. */
  children?: ReactNode;
}

const FALLBACK = { width: 1280, height: 800 };
/** A recorded page settles for this long after the moment asked for. */
const SETTLE_MS = 1000;

/** Measures the room there is and reports the stage that fits it. */
function useStage(
  width: number,
  height: number,
  viewportHeight: number | null,
  onReady: (stage: SnapshotStage) => void,
) {
  // Kept in state, not a ref: the box can appear after the first render.
  const [node, box] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    if (!node) return;
    const measure = () => setRoom(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  const scale = room > 0 ? Math.min(1, room / width) : 0;
  useEffect(() => {
    if (scale > 0) onReady({ width, height, scale, viewportHeight });
  }, [onReady, width, height, scale, viewportHeight]);
  return { box, scale };
}

/** The scaled box the page and whatever is drawn over it share. */
function Sheet({
  box,
  width,
  height,
  scale,
  note,
  page,
  children,
}: {
  box: (node: HTMLDivElement | null) => void;
  width: number;
  height: number;
  scale: number;
  note?: ReactNode;
  page: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div ref={box} className="w-full">
      {note}
      <div
        className="relative mx-auto overflow-hidden bg-surface"
        style={{ width: width * scale, height: height * scale }}
      >
        {page}
        {scale > 0 ? children : null}
      </div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-hint text-fg-meta">{children}</p>;
}

/** Faint rules where each screenful ends, on a page nobody recorded. */
function Rules({ height, every, scale }: { height: number; every: number; scale: number }) {
  const count = Math.max(0, Math.ceil(height / every) - 1);
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
          key={index}
          className="absolute inset-x-0 border-t border-line"
          style={{ top: (index + 1) * every * scale }}
        />
      ))}
    </div>
  );
}

function Blank({
  width,
  height,
  onReady,
  note,
  children,
}: Pick<SnapshotProps, 'width' | 'height' | 'onReady' | 'children'> & { note: ReactNode }) {
  const pageWidth = width > 0 ? width : FALLBACK.width;
  const pageHeight = Math.max(height, FALLBACK.height);
  const { box, scale } = useStage(pageWidth, pageHeight, null, onReady);
  return (
    <Sheet
      box={box}
      width={pageWidth}
      height={pageHeight}
      scale={scale}
      note={note}
      page={<Rules height={pageHeight} every={FALLBACK.height} scale={scale} />}
    >
      {children}
    </Sheet>
  );
}

const NO_RECORDING = (
  <Note>No recording of this page yet, so the map is drawn on a blank page.</Note>
);

function Recorded({
  projectId,
  recordingId,
  ts,
  width,
  height,
  onReady,
  children,
}: SnapshotProps & { recordingId: string }) {
  const stream = useRecordingEvents(projectId, recordingId);
  const events = stream.data?.events;
  const data = useMemo(() => derive(events ?? []), [events]);

  const root = useRef<HTMLDivElement>(null);
  // What the Replayer's callbacks read: always the latest render's values.
  const latest = useRef({ events, data });
  const [resized, setResized] = useState<{ width: number; height: number } | null>(null);
  const viewport = resized ?? data.viewport;
  const pageWidth = viewport?.width ?? (width > 0 ? width : FALLBACK.width);
  const pageHeight = Math.max(height, viewport?.height ?? FALLBACK.height);
  const { box, scale } = useStage(pageWidth, pageHeight, viewport?.height ?? null, onReady);

  /** The whole page at its recorded width, scaled to the room there is, from its top. */
  const fit = useCallback(() => {
    const wrapper = root.current?.querySelector<HTMLElement>('.replayer-wrapper');
    if (!wrapper) return;
    wrapper.style.width = `${pageWidth}px`;
    wrapper.style.height = `${pageHeight}px`;
    wrapper.style.transform = `scale(${scale})`;
    const frame = wrapper.querySelector('iframe');
    if (frame) {
      frame.style.width = `${pageWidth}px`;
      frame.style.height = `${pageHeight}px`;
      try {
        frame.contentWindow?.scrollTo(0, 0);
      } catch {
        // The frame is not ready to scroll yet; the next fit does it.
      }
    }
    const cursor = wrapper.querySelector<HTMLElement>('.replayer-mouse');
    if (cursor) cursor.style.display = 'none';
  }, [pageWidth, pageHeight, scale]);
  const latestFit = useRef(fit);
  useLayoutEffect(() => {
    latest.current = { events, data };
    latestFit.current = fit;
  });

  // Built once there is something to show, paused at the moment asked for. It never plays.
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
      mouseTail: false,
    });
    player.on('resize', (size) => {
      const next = (size ?? {}) as { width?: number; height?: number };
      if (next.width && next.height) setResized({ width: next.width, height: next.height });
    });
    player.on('fullsnapshot-rebuilded', () => latestFit.current());
    const { startedAt, durationMs } = latest.current.data;
    player.pause(Math.max(0, Math.min(durationMs, ts - startedAt + SETTLE_MS)));
    latestFit.current();
    return () => {
      player.destroy();
      mount.innerHTML = '';
    };
  }, [data.playable, ts]);

  useLayoutEffect(() => {
    fit();
  }, [fit, data.playable]);

  if (!stream.data && !stream.isPending) {
    return (
      <Blank
        width={width}
        height={height}
        onReady={onReady}
        note={
          <ErrorNote
            className="py-3"
            error={stream.error}
            onRetry={() => void stream.refetch()}
          />
        }
      >
        {children}
      </Blank>
    );
  }
  if (stream.data && !data.playable) {
    return (
      <Blank width={width} height={height} onReady={onReady} note={NO_RECORDING}>
        {children}
      </Blank>
    );
  }

  return (
    <Sheet
      box={box}
      width={pageWidth}
      height={pageHeight}
      scale={scale}
      page={
        <>
          <div ref={root} className="pointer-events-none absolute inset-0" aria-hidden="true" />
          {stream.isPending ? (
            <p
              role="status"
              className="absolute inset-x-0 top-10 text-center text-control text-fg-meta"
            >
              Loading the page
            </p>
          ) : (
            // A veil, so the map reads on a page of any colour.
            <div className="pointer-events-none absolute inset-0 bg-scrim opacity-50" />
          )}
        </>
      }
    >
      {children}
    </Sheet>
  );
}

export function PageSnapshot(props: SnapshotProps) {
  const { recordingId } = props;
  if (!recordingId) {
    return (
      <Blank width={props.width} height={props.height} onReady={props.onReady} note={NO_RECORDING}>
        {props.children}
      </Blank>
    );
  }
  return <Recorded key={`${recordingId}:${props.ts}`} {...props} recordingId={recordingId} />;
}
