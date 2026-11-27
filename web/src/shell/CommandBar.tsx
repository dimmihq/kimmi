import { Dialog } from '@base-ui/react/dialog';
import { CornerDownLeft, type LucideIcon, Moon, PlayCircle, Plus, Search, Sun } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DEFAULT_RECORDING_FILTERS, useRecordings, visitorLabel } from '@/api/app';
import { useProjects } from '@/api/queries';
import { duration } from '@/lib/format';
import { cn, Kbd } from '@/ui';
import { ProjectTile } from './AppFrame';
import { ALL_WORKSPACE_SETTINGS, OVERVIEW, PROJECT_PAGES, PROJECT_SETTINGS, visiblePages } from './nav';
import { setTheme, useTheme } from './theme';

const RECENT = { ...DEFAULT_RECORDING_FILTERS, limit: 4 };

interface Command {
  id: string;
  group: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  leading?: ReactNode;
  keywords?: string;
  run: () => void;
}

export function CommandBar({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const projects = useProjects().data;
  const current = projects?.find((entry) => entry.id === projectId) ?? projects?.[0];
  const recent = useRecordings(current?.id, RECENT, { enabled: open }).data?.items;

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => navigate(href);
    const base = current ? `/projects/${current.id}` : '';
    const scoped = (list: Command[]) => (current ? list : []);
    return [
      ...scoped([OVERVIEW, ...visiblePages(PROJECT_PAGES, current?.analytics)].map((page) => ({
        id: `page:${page.key}`,
        group: current?.name ?? '',
        label: page.label,
        description: page.description,
        icon: page.icon,
        keywords: page.keywords?.join(' '),
        run: go(`${base}${page.href}`),
      }))),
      ...scoped(
        (recent ?? []).map((entry) => ({
          id: entry.id,
          group: 'Recent recordings',
          label: visitorLabel(entry.visitor),
          description: `${entry.entry} · ${duration(entry.durationMs)}`,
          icon: PlayCircle,
          keywords: 'recording session replay',
          run: go(`${base}/recordings/${entry.id}`),
        })),
      ),
      ...(projects ?? []).map((entry) => ({
        id: `project:${entry.id}`,
        group: 'Projects',
        label: entry.name,
        description: entry.origin.replace(/^https?:\/\//, ''),
        leading: <ProjectTile project={entry} />,
        keywords: 'project switch',
        run: go(`/projects/${entry.id}`),
      })),
      {
        id: 'new-project',
        group: 'Projects',
        label: 'New project',
        description: 'Create a project and install the snippet',
        icon: Plus,
        run: go('/projects/new'),
      },
      ...scoped(
        visiblePages(PROJECT_SETTINGS, current?.analytics).map((page) => ({
          id: `ps:${page.key}`,
          group: `${current?.name ?? ''} settings`,
          label: page.label,
          description: page.description,
          icon: page.icon,
          keywords: page.keywords?.join(' '),
          run: go(`${base}${page.href}`),
        })),
      ),
      ...ALL_WORKSPACE_SETTINGS.map((page) => ({
        id: `ws:${page.key}`,
        group: 'Settings',
        label: page.label,
        description: page.description,
        icon: page.icon,
        keywords: page.keywords?.join(' '),
        run: go(page.href),
      })),
      {
        id: 'theme',
        group: 'Settings',
        label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        icon: theme === 'dark' ? Sun : Moon,
        keywords: 'theme appearance dark light',
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
    ];
  }, [navigate, current, recent, projects, theme]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.description ?? ''} ${command.keywords ?? ''} ${command.group}`
        .toLowerCase()
        .includes(needle),
    );
  }, [commands, query]);

  useEffect(() => setCursor(0), [query, open]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    onOpenChange(false);
    command.run();
  };

  let previousGroup = '';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          aria-label="Command bar"
          className="fixed left-1/2 top-[14vh] z-50 flex max-h-[62vh] w-[620px] max-w-[calc(100vw-24px)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line-field bg-floating shadow-dialog outline-none transition-[opacity,transform] duration-150 data-[ending-style]:scale-[0.98] data-[starting-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        >
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
            <Search className="size-4 text-fg-meta" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setCursor((value) => Math.min(results.length - 1, value + 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setCursor((value) => Math.max(0, value - 1));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  run(results[cursor]);
                }
              }}
              placeholder="Search pages, projects and recordings"
              className="h-full flex-1 bg-transparent text-value text-fg placeholder:text-fg-ghost focus:outline-none"
            />
            <Kbd>esc</Kbd>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {results.length === 0 ? (
              <p className="px-3 py-10 text-center text-body text-fg-meta">
                Nothing matches “{query}”.
              </p>
            ) : (
              results.map((command, index) => {
                const heading = command.group !== previousGroup;
                previousGroup = command.group;
                return (
                  <div key={command.id}>
                    {heading ? (
                      <div className="px-2.5 pb-1 pt-2.5 text-hint font-medium text-fg-ghost">
                        {command.group}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onMouseMove={() => setCursor(index)}
                      onClick={() => run(command)}
                      ref={(node) => {
                        if (node && index === cursor) node.scrollIntoView({ block: 'nearest' });
                      }}
                      className={cn(
                        'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-control',
                        index === cursor ? 'bg-active text-fg' : 'text-fg-secondary',
                      )}
                    >
                      {command.leading}
                      {command.icon ? <command.icon className="size-[15px] text-fg-meta" /> : null}
                      <span className="shrink-0">{command.label}</span>
                      <span className="min-w-0 flex-1 truncate text-hint text-fg-meta">
                        {command.description}
                      </span>
                      {index === cursor ? <CornerDownLeft className="size-3.5 text-fg-meta" /> : null}
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div className="flex h-9 shrink-0 items-center gap-4 border-t border-line px-4 text-hint text-fg-meta">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd> to open
            </span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
