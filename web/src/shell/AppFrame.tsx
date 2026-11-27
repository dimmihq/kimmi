import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  ChevronsUpDown,
  FolderKanban,
  LogOut,
  type LucideIcon,
  Menu as MenuIcon,
  PanelLeft,
  Plus,
  Search,
  SearchX,
  Settings,
  UsersRound,
} from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLogout, useRouteProject } from '@/api/app';
import { errorMessage } from '@/api/http';
import { useMe, useProjects } from '@/api/queries';
import type { Project } from '@/api/types';
import { PLATFORM_COLOR } from '@/lib/format';
import {
  Avatar,
  cn,
  EmptyState,
  Kbd,
  LinkButton,
  Menu,
  type MenuAction,
  Page,
  Tag,
  Tooltip,
  toast,
} from '@/ui';
import { CommandBar } from './CommandBar';
import {
  ACCOUNT_SETTINGS,
  ALL_WORKSPACE_SETTINGS,
  DOCS_URL,
  isSettingsPath,
  isUnder,
  type NavPage,
  OVERVIEW,
  PROJECT_PAGES,
  PROJECT_SETTINGS,
  projectGroups,
  visiblePages,
  WORKSPACE_SETTINGS,
} from './nav';
import { ErrorNote, Skeleton } from './states';

/* ------------------------------------------------------------------- Brand */

/** The kimmi mark: a lens with a play cut and dimmi's three fade cuts. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="4 4 40 40"
      aria-hidden="true"
      className="shrink-0 fill-fg"
      fillRule="evenodd"
    >
      <path d="M4,24 A20,20 0 0 1 17.714,5.014 L42.986,30.286 A20,20 0 0 1 4,24 Z M16.6,21.3 L28.4,28.1 A1.5,1.5 0 0 1 28.4,30.7 L16.6,37.5 A1.5,1.5 0 0 1 14.35,36.2 L14.35,22.6 A1.5,1.5 0 0 1 16.6,21.3 Z" />
      <path d="M19.756,4.456 A20,20 0 0 1 24.713,4.013 L43.987,23.287 A20,20 0 0 1 43.544,28.244 Z" />
      <path d="M27.633,4.333 A20,20 0 0 1 34.99,7.29 L40.71,13.01 A20,20 0 0 1 43.667,20.367 Z" />
    </svg>
  );
}

const LETTER_I = 'M0,0 H125 V118 H0 Z M0,240 H125 V640 H0 Z';
const LETTER_M =
  'M0,640 L0,240 L125,240 L125,285 C153.111,250 198.089,228 259.933,228 C321.778,228 361.133,250 378,285 C406.111,250 451.089,228 512.933,228 C574.778,228 631,270 631,350 L631,640 L506,640 L506,370 C506,335 486.8,320 454.8,320 C416.4,320 378,345 378,385 L378,640 L253,640 L253,370 C253,335 233.8,320 201.8,320 C163.4,320 125,345 125,385 L125,640 Z';

/** The wordmark, drawn rather than set in a font. */
export function Wordmark({ height = 15, className }: { height?: number; className?: string }) {
  return (
    <svg
      height={height}
      viewBox="0 0 2104 640"
      role="img"
      aria-label="kimmi"
      className={cn('shrink-0 fill-fg', className)}
    >
      <path d="M0,0 H125 V386 L268,240 H424 L262,404 L440,640 H287 L176,488 L125,540 V640 H0 Z" />
      <path transform="translate(478,0)" d={LETTER_I} />
      <path transform="translate(641,0)" d={LETTER_M} />
      <path transform="translate(1310,0)" d={LETTER_M} />
      <path transform="translate(1979,0)" d={LETTER_I} />
    </svg>
  );
}

export function ProjectTile({
  project,
  size = 18,
}: {
  project: Pick<Project, 'name' | 'platform'>;
  size?: number;
}) {
  const color = PLATFORM_COLOR[project.platform];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[5px] font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.52,
        color,
        background: `color-mix(in oklab, ${color} 18%, transparent)`,
        borderRadius: size > 22 ? 8 : 5,
      }}
    >
      {project.name[0]}
    </span>
  );
}

/* ------------------------------------------------------------------- Trail */

interface TrailCrumb {
  label: string;
  mono?: boolean;
}

const TrailContext = createContext<{
  trail: TrailCrumb[];
  setTrail: (trail: TrailCrumb[]) => void;
}>({ trail: [], setTrail: () => {} });

/** A page below its section names itself here: a recording, a visitor. */
export function useTrail(label: string | null, mono = false) {
  const { setTrail } = useContext(TrailContext);
  useEffect(() => {
    setTrail(label ? [{ label, mono }] : []);
    return () => setTrail([]);
  }, [label, mono, setTrail]);
}

/* ----------------------------------------------------------------- Project */

const ProjectContext = createContext<Project | null>(null);

/** The project of a page under `/projects/:projectId`; the frame has loaded it. */
export function useProjectScope(): Project {
  const project = useContext(ProjectContext);
  if (!project) throw new Error('useProjectScope is only for pages inside a project');
  return project;
}

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' } as const;

/* ----------------------------------------------------------------- Sidebar */

function SidebarItem({
  icon: Icon,
  leading,
  label,
  href,
  active,
  badge,
  external,
  onNavigate,
}: {
  icon?: LucideIcon;
  leading?: ReactNode;
  label: string;
  href: string;
  active?: boolean;
  badge?: ReactNode;
  external?: boolean;
  onNavigate?: () => void;
}) {
  const className = cn(
    'group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-control transition-colors duration-75',
    active
      ? 'bg-active text-fg'
      : 'text-fg-muted hover:bg-hover hover:text-fg-secondary',
  );
  const body = (
    <>
      {leading}
      {Icon ? (
        <Icon
          className={cn('size-[15px] shrink-0', active ? 'text-fg' : 'text-fg-meta group-hover:text-fg-muted')}
          strokeWidth={1.9}
        />
      ) : null}
      <span className="flex-1 truncate">{label}</span>
      {badge}
    </>
  );
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {body}
    </a>
  ) : (
    <Link to={href} className={className} onClick={onNavigate}>
      {body}
    </Link>
  );
}

function SidebarGroup({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-5">
      <div className="mb-1 flex h-6 items-center justify-between px-2.5">
        <span className="text-hint font-medium text-fg-ghost">{label}</span>
        {action}
      </div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  );
}

function Sidebar({
  project,
  onNavigate,
  onSearch,
}: {
  project: Project | null;
  onNavigate?: () => void;
  onSearch: () => void;
}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const me = useMe().data;
  const projects = useProjects().data ?? [];
  const logout = useLogout();
  const settings = isSettingsPath(pathname);
  const base = project ? `/projects/${project.id}` : '';
  const scope = settings ? 'settings' : project ? `project:${project.id}` : 'workspace';
  const depth = settings ? 2 : project ? 1 : 0;
  // Decided while rendering, so the rows mount already knowing which way to
  // come in: an effect would paint them once and then replay the animation.
  const [last, setLast] = useState<{ scope: string; depth: number; direction?: 'forward' | 'back' }>({
    scope,
    depth,
  });
  if (last.scope !== scope) {
    setLast({ scope, depth, direction: depth >= last.depth ? 'forward' : 'back' });
  }
  const [openProject, setOpenProject] = useState<string | null>(project?.id ?? null);
  const [seenProject, setSeenProject] = useState(project?.id);
  if (seenProject !== project?.id) {
    setSeenProject(project?.id);
    if (project) setOpenProject(project.id);
  }

  const switcher: MenuAction[] = [
    { id: 'all', label: 'All projects', icon: FolderKanban, onSelect: () => navigate('/projects') },
    ...projects.map((option, index) => ({
      id: option.id,
      label: option.name,
      leading: <ProjectTile project={option} />,
      selected: option.id === project?.id,
      separated: index === 0,
      onSelect: () => navigate(`/projects/${option.id}`),
    })),
    { id: 'new', label: 'New project', icon: Plus, separated: true, onSelect: () => navigate('/projects/new') },
  ];

  const liveCount = project?.stats.live ?? 0;

  const signOut = () =>
    logout.mutate(undefined, {
      onSuccess: () => navigate('/login', { replace: true }),
      onError: (error) => {
        toast(errorMessage(error));
        navigate('/login', { replace: true });
      },
    });

  return (
    <nav aria-label="Main" className="flex h-full w-64 shrink-0 flex-col px-2 pb-2 pt-1.5">
      <div className="flex h-11 items-center gap-1 px-1">
        {project && !settings ? (
          <Menu
            actions={switcher}
            className="w-60"
            trigger={
              <button
                type="button"
                className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 text-left hover:bg-hover"
              >
                <ProjectTile project={project} size={22} />
                <span className="min-w-0 flex-1 truncate text-card-title text-fg">{project.name}</span>
                <ChevronsUpDown className="size-3.5 text-fg-ghost" />
              </button>
            }
          />
        ) : (
          <Link to="/projects" onClick={onNavigate} className="flex h-9 flex-1 items-center gap-2.5 rounded-md px-1.5">
            <Mark />
            <Wordmark />
          </Link>
        )}
      </div>

      <button
        type="button"
        onClick={onSearch}
        className="mx-0 mb-2 mt-1 flex h-8 items-center gap-2.5 rounded-md border border-line bg-hover px-2.5 text-control text-fg-meta transition-colors hover:border-line-field hover:text-fg-muted"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Search</span>
        <Kbd>⌘K</Kbd>
      </button>

      <div
        key={scope}
        className={cn(
          'flex-1 overflow-y-auto',
          last.direction === 'forward' && 'animate-enter-forward',
          last.direction === 'back' && 'animate-enter-back',
        )}
      >
        {settings ? (
          <>
            <SidebarItem
              icon={ArrowLeft}
              label={project ? project.name : 'All projects'}
              href={project ? base : '/projects'}
              onNavigate={onNavigate}
            />
            <SidebarGroup label="Account">
              {ACCOUNT_SETTINGS.map((page) => (
                <NavLink key={page.key} page={page} href={page.href} pathname={pathname} onNavigate={onNavigate} />
              ))}
            </SidebarGroup>
            {WORKSPACE_SETTINGS.map((group) => (
              <SidebarGroup key={group.label} label={group.label}>
                {group.pages.map((page) => (
                  <NavLink key={page.key} page={page} href={page.href} pathname={pathname} onNavigate={onNavigate} />
                ))}
              </SidebarGroup>
            ))}
            <SidebarGroup label="Projects">
              {projects.map((option) => {
                const open = openProject === option.id;
                const optionBase = `/projects/${option.id}`;
                return (
                  <div key={option.id}>
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setOpenProject(open ? null : option.id)}
                      className="group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-control text-fg-muted transition-colors duration-75 hover:bg-hover hover:text-fg-secondary"
                    >
                      <ProjectTile project={option} />
                      <span className="flex-1 truncate">{option.name}</span>
                      <ChevronRight
                        className={cn(
                          'size-3.5 text-fg-ghost transition-transform duration-150',
                          open && 'rotate-90',
                        )}
                      />
                    </button>
                    {open ? (
                      <div className="ml-[19px] flex animate-swap-in flex-col gap-px border-l border-line pl-2">
                        {visiblePages(PROJECT_SETTINGS, option.analytics).map((page) => (
                          <NavLink
                            key={page.key}
                            page={page}
                            href={`${optionBase}${page.href}`}
                            pathname={pathname}
                            onNavigate={onNavigate}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </SidebarGroup>
          </>
        ) : project ? (
          <>
            <NavLink page={OVERVIEW} href={base} pathname={pathname} exact onNavigate={onNavigate} />
            {projectGroups(project.analytics).map((group) => (
              <SidebarGroup key={group.label} label={group.label}>
                {group.pages.map((page) => (
                  <NavLink
                    key={page.key}
                    page={page}
                    href={`${base}${page.href}`}
                    pathname={pathname}
                    onNavigate={onNavigate}
                    badge={
                      page.key === 'live' && liveCount > 0 ? (
                        <Tag tone="brand" dot>
                          {liveCount}
                        </Tag>
                      ) : undefined
                    }
                  />
                ))}
              </SidebarGroup>
            ))}
          </>
        ) : (
          <>
            <SidebarItem
              icon={FolderKanban}
              label="All projects"
              href="/projects"
              active={pathname === '/projects'}
              onNavigate={onNavigate}
            />
            <SidebarItem
              icon={UsersRound}
              label="Team"
              href="/settings/team"
              onNavigate={onNavigate}
            />
            <SidebarGroup
              label="Projects"
              action={
                <Tooltip label="New project">
                  <Link
                    to="/projects/new"
                    aria-label="New project"
                    className="flex size-5 items-center justify-center rounded text-fg-ghost hover:bg-hover hover:text-fg"
                  >
                    <Plus className="size-3.5" />
                  </Link>
                </Tooltip>
              }
            >
              {projects.map((option) => (
                <SidebarItem
                  key={option.id}
                  leading={<ProjectTile project={option} />}
                  label={option.name}
                  href={`/projects/${option.id}`}
                  onNavigate={onNavigate}
                />
              ))}
            </SidebarGroup>
          </>
        )}
      </div>

      <div className="flex flex-col gap-px pt-2">
        {settings ? null : (
          <>
            <SidebarItem
              icon={Settings}
              label="Settings"
              href={project ? `${base}/settings/general` : '/settings/profile'}
              onNavigate={onNavigate}
            />
            <SidebarItem icon={BookOpen} label="Docs" href={DOCS_URL} external />
          </>
        )}
        <Menu
          align="start"
          className="w-60"
          actions={[
            { id: 'settings', label: 'Account settings', icon: Settings, onSelect: () => navigate('/settings/profile') },
            { id: 'out', label: 'Sign out', icon: LogOut, tone: 'danger', separated: true, onSelect: signOut },
          ]}
          trigger={
            <button
              type="button"
              className="mt-1 flex h-11 items-center gap-2.5 rounded-md px-2 text-left hover:bg-hover"
            >
              <Avatar name={me?.user.name ?? ''} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-control text-fg">{me?.user.email}</span>
                <span className="block text-hint text-fg-meta">
                  {me ? ROLE_LABEL[me.user.role] : null}
                </span>
              </span>
              <ChevronsUpDown className="size-3.5 text-fg-ghost" />
            </button>
          }
        />
      </div>
    </nav>
  );
}

function NavLink({
  page,
  href,
  pathname,
  exact,
  badge,
  onNavigate,
}: {
  page: NavPage;
  href: string;
  pathname: string;
  exact?: boolean;
  badge?: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <SidebarItem
      icon={page.icon}
      label={page.label}
      href={href}
      active={exact ? pathname === href || pathname === `${href}/` : isUnder(pathname, href)}
      badge={badge}
      onNavigate={onNavigate}
    />
  );
}

/* ------------------------------------------------------------- Breadcrumbs */

interface Crumb {
  label: string;
  href?: string;
  leading?: ReactNode;
  mono?: boolean;
}

function useCrumbs(trail: TrailCrumb[], project: Project | null): Crumb[] {
  const { pathname } = useLocation();
  return useMemo(() => {
    const base = project ? `/projects/${project.id}` : '';
    const projectCrumb: Crumb[] = project
      ? [{ label: project.name, href: base, leading: <ProjectTile project={project} /> }]
      : [];
    if (isSettingsPath(pathname)) {
      const page = [
        ...ALL_WORKSPACE_SETTINGS,
        ...PROJECT_SETTINGS.map((entry) => ({ ...entry, href: `${base}${entry.href}` })),
      ].find((entry) => isUnder(pathname, entry.href));
      return [...projectCrumb, { label: 'Settings' }, ...(page ? [{ label: page.label }] : [])];
    }
    if (project) {
      const page = PROJECT_PAGES.find((entry) => isUnder(pathname, `${base}${entry.href}`));
      if (!page) return [...projectCrumb, { label: 'Overview' }];
      const section = `${base}${page.href}`;
      const below = pathname.length > section.length + 1;
      return below
        ? [...projectCrumb, { label: page.label, href: section }, ...trail]
        : [...projectCrumb, { label: page.label }];
    }
    if (pathname.startsWith('/projects/new')) {
      return [{ label: 'Projects', href: '/projects' }, { label: 'New project' }];
    }
    return [{ label: 'Projects' }];
  }, [pathname, project, trail]);
}

function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <ol className="flex min-w-0 items-center gap-1.5 text-control">
      {items.map((item, index) => {
        const last = index === items.length - 1;
        const body = (
          <span className={cn('flex items-center gap-2 truncate', item.mono && 'font-mono text-mono')}>
            {item.leading}
            {item.label}
          </span>
        );
        return (
          <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
            {index > 0 ? <span className="text-fg-ghost">/</span> : null}
            {item.href && !last ? (
              <Link to={item.href} className="truncate text-fg-meta hover:text-fg">
                {body}
              </Link>
            ) : (
              <span className={cn('truncate', last ? 'text-fg' : 'text-fg-meta')}>{body}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------- Frame */

export function AppFrame() {
  const [trail, setTrail] = useState<TrailCrumb[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const context = useMemo(() => ({ trail, setTrail }), [trail]);
  const route = useRouteProject();
  const project = route.project ?? null;
  const crumbs = useCrumbs(trail, project);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <TrailContext.Provider value={context}>
      <div className="flex h-full bg-canvas md:p-2 md:pl-0">
        <div
          className={cn(
            'hidden overflow-hidden transition-[width] duration-200 ease-standard md:block',
            collapsed ? 'w-2' : 'w-64',
          )}
        >
          <Sidebar project={project} onSearch={() => setCommandOpen(true)} />
        </div>

        {drawer ? (
          <div className="fixed inset-0 z-40 md:hidden">
            <button
              type="button"
              aria-label="Close menu"
              className="absolute inset-0 bg-scrim"
              onClick={() => setDrawer(false)}
            />
            <div className="absolute inset-y-0 left-0 animate-enter-back bg-canvas shadow-overlay">
              <Sidebar
                project={project}
                onNavigate={() => setDrawer(false)}
                onSearch={() => {
                  setDrawer(false);
                  setCommandOpen(true);
                }}
              />
            </div>
          </div>
        ) : null}

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden border-line bg-panel md:rounded-xl md:border">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
            <button
              type="button"
              aria-label="Open menu"
              onClick={() => setDrawer(true)}
              className="flex size-[30px] items-center justify-center rounded-md text-fg-muted hover:bg-hover md:hidden"
            >
              <MenuIcon className="size-4" />
            </button>
            <Tooltip label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="bottom">
              <button
                type="button"
                aria-label="Toggle sidebar"
                onClick={() => setCollapsed((value) => !value)}
                className="hidden size-[30px] items-center justify-center rounded-md text-fg-meta hover:bg-hover hover:text-fg md:flex"
              >
                <PanelLeft className="size-[15px]" />
              </button>
            </Tooltip>
            <div className="mx-0.5 hidden h-4 w-px bg-line md:block" />
            <Breadcrumbs items={crumbs} />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto" id="sheet-scroll">
            {!route.projectId ? (
              <Outlet />
            ) : project ? (
              <ProjectContext.Provider value={project}>
                <Outlet />
              </ProjectContext.Provider>
            ) : route.pending ? (
              <Page>
                <Skeleton className="h-7 w-48" />
                <Skeleton className="mt-2 h-3 w-72" />
              </Page>
            ) : route.notFound ? (
              <Page>
                <EmptyState
                  icon={SearchX}
                  title="Project not found"
                  description="It may have been deleted, or you may not have access to it."
                  action={<LinkButton to="/projects">All projects</LinkButton>}
                />
              </Page>
            ) : (
              <Page>
                <ErrorNote error={route.error} onRetry={() => void route.retry()} />
              </Page>
            )}
          </div>
        </main>
      </div>
      <CommandBar open={commandOpen} onOpenChange={setCommandOpen} />
    </TrailContext.Provider>
  );
}
