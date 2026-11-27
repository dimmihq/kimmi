import { MousePointerClick } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  type DeviceClass,
  type Heatmap,
  recordingsHref,
  useHeatmap,
  useHeatmapPages,
} from '@/api/analytics';
import { ErrorNote, Skeleton } from '@/shell/states';
import {
  cn,
  EmptyState,
  LinkButton,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Segmented,
  Select,
} from '@/ui';
import {
  BLOB_RADIUS,
  canvasDensity,
  cellCenter,
  colourise,
  maxCount,
  palette,
  type Rgb,
  ramp,
  reach,
  strongest,
} from './analytics/heat';
import { PageSnapshot, type SnapshotStage } from './analytics/snapshot';
import { DaysPicker, useDays } from './analytics/window';

type Device = 'Desktop' | 'Tablet' | 'Mobile' | 'All';
type View = 'clicks' | 'scroll';

const DEVICES: Device[] = ['Desktop', 'Tablet', 'Mobile', 'All'];
const VIEWS: View[] = ['clicks', 'scroll'];
const DEFAULTS = { device: 'Desktop' as Device, view: 'clicks' as View };

const count = (value: number) => value.toLocaleString();
const plural = (value: number, one: string, many: string) =>
  `${count(value)} ${value === 1 ? one : many}`;
const share = (part: number, whole: number) =>
  `${whole > 0 ? Math.round((part / whole) * 100) : 0}%`;

const oneOf = <T extends string>(options: readonly T[], value: string | null, fallback: T) =>
  options.find((option) => option === value) ?? fallback;

/** The page, device and view live in the query string beside the window, so every map is linkable. */
function useControls() {
  const [params, setParams] = useSearchParams();
  const set = useCallback(
    (key: 'path' | 'device' | 'view', value: string) =>
      setParams(
        (current) => {
          const out = new URLSearchParams(current);
          if (key !== 'path' && value === DEFAULTS[key]) out.delete(key);
          else out.set(key, value);
          return out;
        },
        { replace: true },
      ),
    [setParams],
  );
  return {
    path: params.get('path') ?? '',
    device: oneOf(DEVICES, params.get('device'), DEFAULTS.device),
    view: oneOf(VIEWS, params.get('view'), DEFAULTS.view),
    set,
  };
}

/* ------------------------------------------------------------------ Clicks */

/** A theme colour as the canvas sees it: the tokens are oklch, pixels are RGB. */
function tokenRgb(from: Element, token: string): Rgb {
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const context = probe.getContext('2d', { willReadFrequently: true });
  if (!context) return [0, 0, 0];
  context.fillStyle = getComputedStyle(from).getPropertyValue(token).trim();
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return [red, green, blue];
}

/**
 * Draws every cell as a soft blob. The blobs add up in an alpha-only map, and
 * the alpha is then turned into colour, so overlapping clicks read as hotter.
 */
function drawClicks(canvas: HTMLCanvasElement, cells: Heatmap['cells'], stage: SnapshotStage) {
  const cssWidth = stage.width * stage.scale;
  const cssHeight = stage.height * stage.scale;
  const density = canvasDensity(cssWidth, cssHeight);
  canvas.width = Math.max(1, Math.round(cssWidth * density));
  canvas.height = Math.max(1, Math.round(cssHeight * density));
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const drawn = strongest(cells);
  const max = maxCount(drawn);
  if (max === 0) return;

  // Page pixels to canvas pixels.
  const zoom = stage.scale * density;
  const radius = Math.max(3, BLOB_RADIUS * zoom);
  const size = Math.ceil(radius * 2);
  const stamp = document.createElement('canvas');
  stamp.width = stamp.height = size;
  const stampContext = stamp.getContext('2d');
  const alpha = document.createElement('canvas');
  alpha.width = canvas.width;
  alpha.height = canvas.height;
  const alphaContext = alpha.getContext('2d', { willReadFrequently: true });
  if (!stampContext || !alphaContext) return;

  const falloff = stampContext.createRadialGradient(radius, radius, 0, radius, radius, radius);
  falloff.addColorStop(0, 'rgba(0, 0, 0, 1)');
  falloff.addColorStop(1, 'rgba(0, 0, 0, 0)');
  stampContext.fillStyle = falloff;
  stampContext.fillRect(0, 0, size, size);

  alphaContext.globalCompositeOperation = 'lighter';
  for (const cell of drawn) {
    const center = cellCenter(cell, stage.width);
    alphaContext.globalAlpha = ramp(cell.n, max);
    alphaContext.drawImage(stamp, center.x * zoom - radius, center.y * zoom - radius);
  }

  const image = alphaContext.getImageData(0, 0, alpha.width, alpha.height);
  colourise(image.data, palette(tokenRgb(canvas, '--brand-fg'), tokenRgb(canvas, '--danger')));
  context.putImageData(image, 0, 0);
}

function ClickMap({ cells, stage }: { cells: Heatmap['cells']; stage: SnapshotStage }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { width, height, scale } = stage;
  // Once per change of the data or the size, never per frame.
  useEffect(() => {
    if (canvas.current) {
      drawClicks(canvas.current, cells, { width, height, scale, viewportHeight: null });
    }
  }, [cells, width, height, scale]);
  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0"
      style={{ width: width * scale, height: height * scale }}
    />
  );
}

/* ------------------------------------------------------------------ Scroll */

const CHIP =
  'rounded-md border border-line-field bg-tooltip px-1.5 py-0.5 text-hint font-medium text-[oklch(0.96_0_0)]';

function ScrollMap({ shares, stage }: { shares: number[]; stage: SnapshotStage }) {
  const fold = stage.viewportHeight;
  return (
    <div className="pointer-events-none absolute inset-0">
      {shares.map((value, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: ten fixed bands
          key={index}
          className="absolute inset-x-0 border-b border-brand/40"
          style={{ top: `${index * 10}%`, height: '10%' }}
        >
          <span className="absolute inset-0 bg-brand" style={{ opacity: value * 0.45 }} />
          {/* One label where the share changes, and at the bottom: ten equal labels say nothing. */}
          {index === shares.length - 1 || Math.round(value * 100) !== Math.round((shares[index + 1] ?? 0) * 100) ? (
            <span className={cn('tabular absolute bottom-1 right-1.5', CHIP)}>
              {Math.round(value * 100)}% reached here
            </span>
          ) : null}
        </div>
      ))}
      {fold && fold < stage.height ? (
        <div
          className="absolute inset-x-0 border-t border-dashed border-warning"
          style={{ top: fold * stage.scale }}
        >
          <span className={cn('absolute left-1.5 top-1', CHIP)}>Average fold</span>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- Side */

function Ranked({
  label,
  mono,
  value,
  detail,
  width,
}: {
  label: string;
  mono?: boolean;
  value: string;
  detail?: string;
  width: number;
}) {
  return (
    <div className="relative flex items-center gap-3 px-4 py-2">
      <span
        className="absolute inset-y-1 left-2 rounded-md bg-selected"
        style={{ width: `calc(${Math.min(1, width) * 100}% - 16px)` }}
      />
      <span
        title={label}
        className={cn(
          'relative min-w-0 flex-1 truncate text-control text-fg-secondary',
          mono && 'font-mono text-mono',
        )}
      >
        {label}
      </span>
      <span className="tabular relative w-12 shrink-0 text-right text-control text-fg">{value}</span>
      {detail ? (
        <span className="tabular relative w-9 shrink-0 text-right text-control text-fg-meta">
          {detail}
        </span>
      ) : null}
    </div>
  );
}

function SideNote({ children }: { children: string }) {
  return <p className="px-4 pb-4 pt-1 text-body text-fg-meta">{children}</p>;
}

function SideSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: 6 }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
        <div key={index} className="flex items-center gap-3 px-4 py-2">
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-8" />
        </div>
      ))}
    </div>
  );
}

function MostClicked({ data }: { data: Heatmap }) {
  const top = Math.max(1, data.elements[0]?.count ?? 0);
  if (data.elements.length === 0) return <SideNote>No clicks on this page in this window.</SideNote>;
  return data.elements.map((element) => (
    <Ranked
      key={element.selector}
      label={element.label ? `“${element.label}”` : element.selector}
      mono={!element.label}
      width={element.count / top}
      value={count(element.count)}
      detail={share(element.count, data.clicks)}
    />
  ));
}

function Reach({ shares, views }: { shares: number[]; views: number }) {
  if (views === 0) return <SideNote>No scroll data for this page in this window.</SideNote>;
  return shares.map((value, index) => (
    <Ranked
      // biome-ignore lint/suspicious/noArrayIndexKey: ten fixed rows
      key={index}
      label={`${(index + 1) * 10}% of the page`}
      width={value}
      value={`${Math.round(value * 100)}%`}
    />
  ));
}

/* -------------------------------------------------------------------- Page */

export function Heatmaps() {
  const { projectId = '' } = useParams();
  const controls = useControls();
  const [days, setDays] = useDays();
  const device: DeviceClass = controls.device === 'All' ? '' : controls.device;
  const pages = useHeatmapPages(projectId, days);
  const path = controls.path || pages.data?.[0]?.path || '';
  const heatmap = useHeatmap(projectId, path, device, days);
  const data = heatmap.data;
  const [stage, setStage] = useState<SnapshotStage | null>(null);
  const settings = `/projects/${projectId}/settings/analytics`;

  const options = useMemo(() => {
    const listed = (pages.data ?? []).map((page) => ({
      value: page.path,
      label: `${page.path} · ${plural(page.count, 'click', 'clicks')}`,
    }));
    // A linked page that has no clicks in this window still shows in the picker.
    return path && !listed.some((option) => option.value === path)
      ? [{ value: path, label: path }, ...listed]
      : listed;
  }, [pages.data, path]);
  const shares = useMemo(() => reach(data?.scroll ?? [], data?.views ?? 0), [data]);

  const header = (
    <PageHeader
      title="Heatmaps"
      description="Where visitors click on a page and how far down they scroll"
      actions={
        <>
          {options.length > 0 ? (
            <Select
              label="Page"
              value={path}
              onChange={(next) => controls.set('path', next)}
              className="w-64"
              options={options}
            />
          ) : null}
          <Segmented
            label="Device"
            value={controls.device}
            onChange={(next) => controls.set('device', next)}
            options={DEVICES.map((value) => ({ value, label: value }))}
          />
          <Segmented
            label="View"
            value={controls.view}
            onChange={(next) => controls.set('view', next)}
            options={[
              { value: 'clicks', label: 'Clicks' },
              { value: 'scroll', label: 'Scroll' },
            ]}
          />
          <DaysPicker value={days} onChange={setDays} />
        </>
      }
    />
  );

  if (!path) {
    return (
      <Page>
        {header}
        <Panel>
          {pages.isPending ? (
            <div className="p-4">
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="mt-4 h-[420px] w-full" />
            </div>
          ) : !pages.data ? (
            <ErrorNote error={pages.error} onRetry={() => void pages.refetch()} />
          ) : (
            <EmptyState
              icon={MousePointerClick}
              title="No heatmaps yet"
              description="Heatmaps fill in as visitors click on your pages. Nothing has been collected in this window: pick a longer one, or check that heatmaps are switched on in the project settings."
              action={<LinkButton to={settings}>Analytics settings</LinkButton>}
            />
          )}
        </Panel>
      </Page>
    );
  }

  return (
    <Page>
      {header}
      <div className="flex flex-col items-start gap-3 lg:flex-row">
        <Panel className="w-full min-w-0 flex-1 overflow-hidden">
          <PanelHeader
            title={path}
            description={
              data ? (
                <span className="tabular">
                  {plural(data.clicks, 'click', 'clicks')} ·{' '}
                  {plural(data.views, 'page view', 'page views')} with scroll data
                </span>
              ) : heatmap.isPending ? (
                <Skeleton className="mt-1 h-3 w-56" />
              ) : null
            }
            action={
              <LinkButton
                size="sm"
                variant="ghost"
                to={recordingsHref(projectId, { path, device })}
              >
                Recordings of this page
              </LinkButton>
            }
          />
          <div className="border-t border-line-subtle bg-stage p-3">
            {heatmap.isPending ? (
              <Skeleton className="h-[520px] w-full" />
            ) : !data ? (
              <ErrorNote error={heatmap.error} onRetry={() => void heatmap.refetch()} />
            ) : (
              <PageSnapshot
                projectId={projectId}
                recordingId={data.snapshot?.recordingId ?? null}
                ts={data.snapshot?.ts ?? 0}
                width={data.width}
                height={data.height}
                onReady={setStage}
              >
                {!stage ? null : controls.view === 'clicks' ? (
                  <ClickMap cells={data.cells} stage={stage} />
                ) : (
                  <ScrollMap shares={shares} stage={stage} />
                )}
              </PageSnapshot>
            )}
          </div>
        </Panel>

        <Panel className="w-full shrink-0 pb-2 lg:sticky lg:top-7 lg:w-[300px]">
          <PanelHeader
            title={controls.view === 'clicks' ? 'Most clicked' : 'Scroll reach'}
            description={
              controls.view === 'clicks'
                ? 'Elements by clicks and their share of all clicks'
                : 'Share of page views that got this far down'
            }
          />
          {heatmap.isPending ? (
            <SideSkeleton />
          ) : !data ? (
            <SideNote>Nothing to list until the map loads.</SideNote>
          ) : controls.view === 'clicks' ? (
            <MostClicked data={data} />
          ) : (
            <Reach shares={shares} views={data.views} />
          )}
        </Panel>
      </div>
    </Page>
  );
}
