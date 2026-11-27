import {
  BarChart3,
  Bell,
  Bug,
  Building2,
  Code2,
  EyeOff,
  Filter,
  Flame,
  Gauge,
  HardDrive,
  Info,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  MousePointerClick,
  Palette,
  PlayCircle,
  Radio,
  Settings,
  Share2,
  SlidersHorizontal,
  Timer,
  TrendingUp,
  User,
  Users,
  UsersRound,
} from 'lucide-react';

export interface NavPage {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Absolute for workspace pages; appended to `/projects/:id` for a project's. */
  href: string;
  description: string;
  keywords?: string[];
  /** Has nothing to show until the project counts visits. */
  needs?: 'analytics';
}

export const OVERVIEW: NavPage = {
  key: 'overview',
  label: 'Overview',
  icon: LayoutDashboard,
  href: '',
  description: 'Recording volume, engagement and friction at a glance',
  keywords: ['dashboard', 'home'],
};

export const PROJECT_PAGES: NavPage[] = [
  {
    key: 'analytics',
    needs: 'analytics',
    label: 'Analytics',
    icon: BarChart3,
    href: '/analytics',
    description: 'Visitors, sources, pages and goals',
    keywords: ['traffic', 'pageviews', 'referrers', 'utm', 'campaigns', 'bounce'],
  },
  {
    key: 'recordings',
    label: 'Recordings',
    icon: PlayCircle,
    href: '/recordings',
    description: 'Every recorded session, with filters',
    keywords: ['sessions', 'replays', 'playback'],
  },
  {
    key: 'live',
    label: 'Live',
    icon: Radio,
    href: '/live',
    description: 'Visitors on the site right now',
    keywords: ['now', 'realtime', 'online'],
  },
  {
    key: 'visitors',
    label: 'Visitors',
    icon: UsersRound,
    href: '/visitors',
    description: 'People and the sessions they recorded',
    keywords: ['users', 'people', 'identify', 'returning', 'cohorts', 'accounts'],
  },
  {
    key: 'funnels',
    needs: 'analytics',
    label: 'Funnels',
    icon: Filter,
    href: '/funnels',
    description: 'Where visitors stop on the way to a goal',
    keywords: ['conversion', 'drop-off', 'steps'],
  },
  {
    key: 'heatmaps',
    needs: 'analytics',
    label: 'Heatmaps',
    icon: Flame,
    href: '/heatmaps',
    description: 'Where people click and how far they scroll',
    keywords: ['clicks', 'scroll', 'map'],
  },
  {
    key: 'errors',
    needs: 'analytics',
    label: 'Errors',
    icon: Bug,
    href: '/errors',
    description: 'Uncaught errors, grouped, with the sessions that hit them',
    keywords: ['exceptions', 'bugs', 'crashes', 'issues'],
  },
  {
    key: 'friction',
    needs: 'analytics',
    label: 'Friction',
    icon: MousePointerClick,
    href: '/friction',
    description: 'Pages and elements people rage-click or dead-click',
    keywords: ['rage', 'dead', 'frustration', 'broken'],
  },
  {
    key: 'performance',
    needs: 'analytics',
    label: 'Performance',
    icon: Gauge,
    href: '/performance',
    description: 'Web vitals per page and failing requests',
    keywords: ['vitals', 'lcp', 'inp', 'cls', 'slow', 'requests'],
  },
  {
    key: 'feedback',
    needs: 'analytics',
    label: 'Feedback',
    icon: MessageSquare,
    href: '/feedback',
    description: 'Messages visitors sent from the site',
    keywords: ['widget', 'messages', 'inbox'],
  },
];

/** How the sidebar groups a project's pages. */
export const PROJECT_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Replay', keys: ['recordings', 'live', 'visitors'] },
  { label: 'Analytics', keys: ['analytics', 'funnels', 'heatmaps'] },
  { label: 'Quality', keys: ['errors', 'friction', 'performance', 'feedback'] },
];

export const PROJECT_SETTINGS: NavPage[] = [
  {
    key: 'general',
    label: 'General',
    icon: Settings,
    href: '/settings/general',
    description: 'Name, allowed origins, delete the project',
    keywords: ['rename', 'delete', 'domain'],
  },
  {
    key: 'install',
    label: 'Install',
    icon: Code2,
    href: '/settings/install',
    description: 'Snippet, npm package and project keys',
    keywords: ['snippet', 'sdk', 'key', 'setup'],
  },
  {
    key: 'privacy',
    label: 'Privacy',
    icon: EyeOff,
    href: '/settings/privacy',
    description: 'What is masked or blocked before it leaves the browser',
    keywords: ['mask', 'block', 'gdpr', 'consent', 'pii'],
  },
  {
    key: 'capture',
    label: 'Capture',
    icon: SlidersHorizontal,
    href: '/settings/capture',
    description: 'Sampling, triggers and what gets recorded',
    keywords: ['sampling', 'triggers', 'console', 'network'],
  },
  {
    key: 'analytics-settings',
    label: 'Analytics',
    icon: TrendingUp,
    href: '/settings/analytics',
    description: 'Visit counting, cookieless mode, goals and funnels',
    keywords: ['cookieless', 'goals', 'funnels', 'heatmaps', 'events', 'feedback'],
  },
  {
    key: 'alerts',
    needs: 'analytics',
    label: 'Alerts',
    icon: Bell,
    href: '/settings/alerts',
    description: 'A webhook for errors, rage clicks and the weekly digest',
    keywords: ['webhook', 'notifications', 'digest'],
  },
  {
    key: 'sharing',
    label: 'Sharing',
    icon: Share2,
    href: '/settings/sharing',
    description: 'Public links to recordings and to analytics',
    keywords: ['public', 'links', 'share'],
  },
  {
    key: 'retention',
    label: 'Retention',
    icon: Timer,
    href: '/settings/retention',
    description: 'How long recordings are kept',
    keywords: ['delete', 'storage', 'ttl'],
  },
  {
    key: 'members',
    label: 'Members',
    icon: Users,
    href: '/settings/members',
    description: 'Who can open this project',
    keywords: ['access', 'people'],
  },
];

export const ACCOUNT_SETTINGS: NavPage[] = [
  {
    key: 'profile',
    label: 'Profile',
    icon: User,
    href: '/settings/profile',
    description: 'Your name, email and password',
    keywords: ['account', 'password', 'me'],
  },
  {
    key: 'preferences',
    label: 'Preferences',
    icon: Palette,
    href: '/settings/preferences',
    description: 'Theme, time zone and player defaults',
    keywords: ['theme', 'dark', 'light', 'appearance'],
  },
];

export const WORKSPACE_SETTINGS: { label: string; pages: NavPage[] }[] = [
  {
    label: 'Access',
    pages: [
      {
        key: 'team',
        label: 'Team',
        icon: Building2,
        href: '/settings/team',
        description: 'Invite people and set their role',
        keywords: ['invite', 'people', 'roles'],
      },
      {
        key: 'tokens',
        label: 'API tokens',
        icon: KeyRound,
        href: '/settings/tokens',
        description: 'Tokens for the REST API',
        keywords: ['auth', 'bearer', 'secret'],
      },
    ],
  },
  {
    label: 'System',
    pages: [
      {
        key: 'storage',
        label: 'Storage',
        icon: HardDrive,
        href: '/settings/storage',
        description: 'Disk and object storage used by recordings',
        keywords: ['disk', 's3', 'retention', 'size'],
      },
      {
        key: 'instance',
        label: 'Instance',
        icon: Info,
        href: '/settings/instance',
        description: 'Version, database and health of this server',
        keywords: ['version', 'about', 'health'],
      },
    ],
  },
];

export const ALL_WORKSPACE_SETTINGS = [
  ...ACCOUNT_SETTINGS,
  ...WORKSPACE_SETTINGS.flatMap((group) => group.pages),
];

export const isUnder = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

export const isSettingsPath = (pathname: string) =>
  /^\/settings(\/|$)|^\/projects\/[^/]+\/settings(\/|$)/.test(pathname);

export const DOCS_URL = 'https://trykimmi.com/docs';

/**
 * Whether a project counts visits: `undefined` while the project is loading,
 * when only the pages that work from recordings alone are shown.
 */
export type AnalyticsState = boolean | undefined;

/** The entries a project shows: those that need analytics only once it is on. */
export const visiblePages = <T extends Pick<NavPage, 'needs'>>(pages: T[], analytics: AnalyticsState) =>
  pages.filter((page) => !page.needs || analytics === true);

/** The sidebar's groups with their pages; a group with none is left out. */
export const projectGroups = (analytics: AnalyticsState) =>
  PROJECT_GROUPS.map((group) => ({
    label: group.label,
    pages: visiblePages(
      PROJECT_PAGES.filter((page) => group.keys.includes(page.key)),
      analytics,
    ),
  })).filter((group) => group.pages.length > 0);
