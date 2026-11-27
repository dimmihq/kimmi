import {
  Building2,
  Code2,
  EyeOff,
  HardDrive,
  Info,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Palette,
  PlayCircle,
  Radio,
  Settings,
  SlidersHorizontal,
  Timer,
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
    keywords: ['users', 'people', 'identify'],
  },
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
