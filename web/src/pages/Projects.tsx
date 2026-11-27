import { ArrowUpDown, ChevronRight, FolderKanban, MoreHorizontal, Plus, Search, Settings } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useProjects } from '@/api/queries';
import type { Project } from '@/api/types';
import { bytes, compact, duration } from '@/lib/format';
import { ProjectTile } from '@/shell/AppFrame';
import { ErrorNote, Skeleton } from '@/shell/states';
import {
  Bars,
  EmptyState,
  Input,
  LinkButton,
  Menu,
  Page,
  PageHeader,
  Select,
  Tag,
} from '@/ui';

type Sort = 'active' | 'name' | 'stored';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-hint text-fg-meta">{label}</div>
      <div className="tabular mt-0.5 text-value font-semibold text-fg">{value}</div>
    </div>
  );
}

function ProjectCard({ entry }: { entry: Project }) {
  const navigate = useNavigate();
  const { stats } = entry;
  const waiting = stats.recordings === 0;
  return (
    <article className="group relative rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-field">
      <div className="flex items-center gap-3">
        <ProjectTile project={entry} size={36} />
        <div className="min-w-0 flex-1">
          <Link
            to={waiting ? `/projects/${entry.id}/settings/install` : `/projects/${entry.id}`}
            className="text-value font-semibold text-fg after:absolute after:inset-0"
          >
            {entry.name}
          </Link>
          <div className="truncate font-mono text-mono text-fg-meta">
            {entry.origin.replace(/^https?:\/\//, '')}
          </div>
        </div>
        {waiting ? (
          <Tag>Waiting for the first recording</Tag>
        ) : (
          <Tag tone="brand" dot>
            {stats.live} live
          </Tag>
        )}
        <Menu
          align="end"
          actions={[
            { id: 'open', label: 'Open recordings', onSelect: () => navigate(`/projects/${entry.id}/recordings`) },
            { id: 'settings', label: 'Project settings', icon: Settings, onSelect: () => navigate(`/projects/${entry.id}/settings/general`) },
          ]}
          trigger={
            <button
              type="button"
              aria-label={`${entry.name} options`}
              className="relative z-10 flex size-7 items-center justify-center rounded-md text-fg-meta hover:bg-hover hover:text-fg"
            >
              <MoreHorizontal className="size-4" />
            </button>
          }
        />
        <ChevronRight className="size-4 text-fg-ghost transition-transform group-hover:translate-x-0.5" />
      </div>

      <div className="mt-5 flex items-center justify-between text-hint text-fg-meta">
        <span>Recordings</span>
        <span>Last 30 days</span>
      </div>
      {waiting ? (
        <div className="mt-2 flex h-11 items-end">
          <div className="w-full border-t border-dashed border-line-strong" />
        </div>
      ) : (
        <Bars values={stats.series} height={44} barWidth={0} className="mt-2 w-full [&>span]:flex-1" />
      )}

      <div className="mt-4 grid grid-cols-4 gap-3 border-t border-line-subtle pt-3.5">
        <Stat label="Recordings 24h" value={compact(stats.recordings24h)} />
        <Stat label="Live now" value={String(stats.live)} />
        <Stat label="Avg duration" value={waiting ? '–' : duration(stats.avgDurationMs)} />
        <Stat label="Stored" value={bytes(stats.storageBytes)} />
      </div>
    </article>
  );
}

/** A card's outline while the list loads. */
function ProjectCardSkeleton() {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-lg" />
        <div className="flex-1">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="mt-2 h-3 w-44" />
        </div>
      </div>
      <Skeleton className="mt-5 h-3 w-24" />
      <Skeleton className="mt-2 h-11 w-full" />
      <div className="mt-4 grid grid-cols-4 gap-3 border-t border-line-subtle pt-3.5">
        {['a', 'b', 'c', 'd'].map((key) => (
          <div key={key}>
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-1.5 h-4 w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function Projects() {
  const projects = useProjects();
  const all = useMemo(() => projects.data ?? [], [projects.data]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('active');
  const list = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = all.filter(
      (entry) =>
        !needle ||
        entry.name.toLowerCase().includes(needle) ||
        entry.origin.includes(needle),
    );
    return [...filtered].sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : sort === 'stored'
          ? b.stats.storageBytes - a.stats.storageBytes
          : b.stats.recordings24h - a.stats.recordings24h,
    );
  }, [all, query, sort]);
  const total = all.reduce((sum, entry) => sum + entry.stats.recordings24h, 0);

  return (
    <Page>
      <PageHeader
        title="Projects"
        description={
          projects.data ? (
            `${all.length} ${all.length === 1 ? 'project' : 'projects'} · ${compact(total)} recordings in 24 h`
          ) : (
            <Skeleton className="mt-1.5 h-3 w-56" />
          )
        }
        actions={
          <LinkButton to="/projects/new" variant="primary" icon={Plus}>
            New project
          </LinkButton>
        }
      />
      <div className="mb-4 flex gap-2">
        <Input
          icon={Search}
          placeholder="Search projects"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-9"
        />
        <Select
          label="Sort projects"
          value={sort}
          onChange={setSort}
          icon={ArrowUpDown}
          className="h-9 w-40"
          options={[
            { value: 'active', label: 'Most active' },
            { value: 'name', label: 'Name' },
            { value: 'stored', label: 'Most stored' },
          ]}
        />
      </div>
      {projects.isPending ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <ProjectCardSkeleton />
          <ProjectCardSkeleton />
        </div>
      ) : !projects.data ? (
        <div className="rounded-xl border border-line bg-surface">
          <ErrorNote error={projects.error} onRetry={() => void projects.refetch()} />
        </div>
      ) : all.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState
            icon={FolderKanban}
            title="Create your first project"
            description="A project is one site or app, with its own key, privacy rules and retention."
            action={
              <LinkButton to="/projects/new" variant="primary" icon={Plus}>
                New project
              </LinkButton>
            }
          />
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No project matches"
          description="Try another name or origin."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.map((entry) => (
            <ProjectCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </Page>
  );
}
