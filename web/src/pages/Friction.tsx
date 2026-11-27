import { Play } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { recordingsHref, useFriction } from '@/api/analytics';
import { compact } from '@/lib/format';
import { ErrorNote, SkeletonRows } from '@/shell/states';
import { cn, LinkButton, Page, PageHeader, Panel, PanelHeader, Tag } from '@/ui';
import { DaysPicker, useDays } from './analytics/window';

const KIND_LABEL = { rage: 'Rage click', dead: 'Dead click' } as const;

function Count({ value, tone }: { value: number; tone: string }) {
  return (
    <span
      className={cn(
        'tabular relative hidden w-14 shrink-0 text-right text-control sm:block',
        value > 0 ? tone : 'text-fg-ghost',
      )}
    >
      {compact(value)}
    </span>
  );
}

export function Friction() {
  const { projectId = '' } = useParams();
  const [days, setDays] = useDays();
  const friction = useFriction(projectId, days);
  const data = friction.data;
  const failed = !friction.isPending && !data;

  return (
    <Page>
      <PageHeader
        title="Friction"
        description="Where visitors click in anger, click on things that do nothing, or hit an error"
        actions={<DaysPicker value={days} onChange={setDays} />}
      />

      <Panel className="overflow-hidden">
        <PanelHeader title="Pages" description="Visits to each page that ran into trouble" />
        <div className="flex h-[38px] items-center gap-4 border-y border-line-subtle px-4 text-label text-fg-meta">
          <span className="min-w-0 flex-1">Page</span>
          <span className="hidden w-14 shrink-0 text-right sm:block">Rage</span>
          <span className="hidden w-14 shrink-0 text-right sm:block">Dead</span>
          <span className="hidden w-14 shrink-0 text-right sm:block">Errors</span>
          <span className="w-14 shrink-0 text-right">Visits</span>
          <span className="w-16 shrink-0 text-right">Troubled</span>
        </div>
        {friction.isPending ? (
          <SkeletonRows count={5} className="h-10" />
        ) : failed ? (
          <ErrorNote error={friction.error} onRetry={() => void friction.refetch()} />
        ) : data && data.pages.length === 0 ? (
          <p className="px-4 py-10 text-center text-body text-fg-meta">
            No page had rage clicks, dead clicks or errors in this window.
          </p>
        ) : (
          data?.pages.map((page) => {
            const share =
              page.visits > 0 ? Math.min(1, (page.rage + page.dead + page.errors) / page.visits) : 0;
            return (
              <Link
                key={page.path}
                to={recordingsHref(projectId, { path: page.path })}
                className="relative flex h-10 items-center gap-4 border-b border-line-subtle px-4 transition-colors duration-75 last:border-b-0 hover:bg-hover"
              >
                <span
                  className="absolute inset-y-1 left-2 rounded-md bg-selected"
                  style={{ width: `calc(${share * 100}% - 16px)` }}
                />
                <span className="relative min-w-0 flex-1 truncate font-mono text-mono text-fg-secondary">
                  {page.path}
                </span>
                <Count value={page.rage} tone="text-warning-fg" />
                <Count value={page.dead} tone="text-fg-secondary" />
                <Count value={page.errors} tone="text-danger-fg" />
                <span className="tabular relative w-14 shrink-0 text-right text-control text-fg-muted">
                  {compact(page.visits)}
                </span>
                <span className="tabular relative w-16 shrink-0 text-right text-control text-fg">
                  {Math.round(share * 100)}%
                </span>
              </Link>
            );
          })
        )}
      </Panel>

      <Panel className="mt-3 overflow-hidden">
        <PanelHeader title="Elements" description="The buttons and links that drew the clicks" />
        <div className="flex h-[38px] items-center gap-4 border-y border-line-subtle px-4 text-label text-fg-meta">
          <span className="w-20 shrink-0">Kind</span>
          <span className="min-w-0 flex-[1.4]">Element</span>
          <span className="hidden min-w-0 flex-1 md:block">Page</span>
          <span className="w-14 shrink-0 text-right">Visits</span>
          <span className="hidden w-14 shrink-0 text-right sm:block">Clicks</span>
          <span className="w-20 shrink-0" />
        </div>
        {friction.isPending ? (
          <SkeletonRows count={5} />
        ) : failed ? (
          <ErrorNote error={friction.error} onRetry={() => void friction.refetch()} />
        ) : data && data.elements.length === 0 ? (
          <p className="px-4 py-10 text-center text-body text-fg-meta">
            No element drew rage or dead clicks in this window. They are recorded when Rage and dead
            clicks is on in the capture settings.
          </p>
        ) : (
          data?.elements.map((element) => (
            <div
              key={`${element.kind}:${element.path}:${element.selector}`}
              className="flex h-12 items-center gap-4 border-b border-line-subtle px-4 last:border-b-0"
            >
              <span className="w-20 shrink-0">
                <Tag tone={element.kind === 'rage' ? 'warning' : 'neutral'}>
                  {KIND_LABEL[element.kind]}
                </Tag>
              </span>
              <span className="min-w-0 flex-[1.4]">
                {element.label ? (
                  <span className="block truncate text-control text-fg">“{element.label}”</span>
                ) : null}
                <span
                  className={cn(
                    'block truncate font-mono',
                    element.label ? 'text-[0.65rem] text-fg-ghost' : 'text-mono text-fg-secondary',
                  )}
                >
                  {element.selector}
                </span>
              </span>
              <span className="hidden min-w-0 flex-1 truncate font-mono text-mono text-fg-muted md:block">
                {element.path}
              </span>
              <span className="tabular w-14 shrink-0 text-right text-control text-fg">
                {compact(element.visits)}
              </span>
              <span className="tabular hidden w-14 shrink-0 text-right text-control text-fg-muted sm:block">
                {compact(element.count)}
              </span>
              <span className="flex w-20 shrink-0 justify-end">
                <LinkButton
                  size="sm"
                  icon={Play}
                  to={recordingsHref(projectId, {
                    event: `${element.kind}:${element.selector}`,
                    eventPath: element.path,
                  })}
                >
                  Watch
                </LinkButton>
              </span>
            </div>
          ))
        )}
      </Panel>
    </Page>
  );
}
