import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FileX,
  Link2,
  Maximize2,
  MessageSquare,
  Minimize2,
  MoreHorizontal,
  Share2,
  Star,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  isNotFound,
  useDeleteRecording,
  useRecording,
  useRecordingEvents,
  useUpdateRecording,
  visitorLabel,
} from '@/api/app';
import { type Note, useCreateNote, useCreateShare, useDeleteNote, useNotes } from '@/api/analytics';
import { errorMessage } from '@/api/http';
import { useMe } from '@/api/queries';
import { canManage, useProjectSettings } from '@/api/settings';
import type { Project, RecordingDetail } from '@/api/types';
import { ago, bytes, clock, day, duration, flag } from '@/lib/format';
import { type ActivityEntry, derive, urlAt } from '@/replay/derive';
import {
  KIND,
  ReplayAddress,
  ReplayControls,
  ReplayStage,
  splitUrl,
  useReplay,
} from '@/replay/stage';
import { useProjectScope, useTrail } from '@/shell/AppFrame';
import { ErrorNote, FormError, Skeleton } from '@/shell/states';
import {
  Button,
  cn,
  CodeBlock,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  LinkButton,
  Menu,
  Page,
  Segmented,
  Select,
  SwitchField,
  Tag,
  toast,
  Tooltip,
} from '@/ui';

type InspectorTab = 'activity' | 'console' | 'network' | 'notes' | 'details';

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
        <aside className="max-h-[42vh] w-full shrink-0 border-t border-line bg-aside lg:max-h-none lg:w-[400px] lg:border-l lg:border-t-0" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- Notes */

function NoteList({
  projectId,
  recordingId,
  notes,
  time,
  onSeek,
  canDelete,
}: {
  projectId: string;
  recordingId: string;
  notes: Note[];
  time: number;
  onSeek: (ms: number) => void;
  canDelete: boolean;
}) {
  const remove = useDeleteNote(projectId, recordingId);
  const [deleting, setDeleting] = useState<Note | null>(null);
  const sorted = useMemo(() => [...notes].sort((a, b) => a.atMs - b.atMs), [notes]);
  return (
    <>
      <ol className="p-1.5">
        {sorted.map((note) => (
          <li
            key={note.id}
            className={cn(
              'flex items-start rounded-md transition-colors duration-75 hover:bg-hover',
              note.atMs > time + 50 && 'opacity-55',
            )}
          >
            <button
              type="button"
              onClick={() => onSeek(note.atMs)}
              className="flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-2 py-1.5 text-left"
            >
              <span className="tabular mt-px w-9 shrink-0 font-mono text-mono text-fg-meta">
                {duration(note.atMs)}
              </span>
              <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-fg-muted" strokeWidth={2} />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-control text-fg-secondary">
                  {note.body}
                </span>
                <span className="block truncate text-hint text-fg-meta">
                  {note.author} · {ago(note.createdAt)}
                </span>
              </span>
            </button>
            {canDelete ? (
              <IconButton
                icon={Trash2}
                label="Delete note"
                onClick={() => setDeleting(note)}
                className="mr-0.5 mt-0.5"
              />
            ) : null}
          </li>
        ))}
      </ol>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this note?"
        description="The note is removed for everyone on the project. This cannot be undone."
        confirmLabel="Delete note"
        danger
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => toast('Note deleted'),
            onError: (error) => toast(errorMessage(error)),
          });
        }}
      />
    </>
  );
}

/** One line at the foot of the Notes tab: Enter adds a note at the current moment. */
function NoteInput({
  projectId,
  recordingId,
  time,
}: {
  projectId: string;
  recordingId: string;
  time: number;
}) {
  const create = useCreateNote(projectId, recordingId);
  const [draft, setDraft] = useState('');
  const label = `Add a note at ${duration(time)}`;
  return (
    <div className="shrink-0 border-t border-line-subtle px-3.5 py-2.5">
      <Input
        aria-label={label}
        placeholder={label}
        value={draft}
        disabled={create.isPending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          const body = draft.trim();
          if (event.key !== 'Enter' || !body || create.isPending) return;
          create.mutate(
            { atMs: Math.round(time), body },
            {
              onSuccess: () => setDraft(''),
              onError: (error) => toast(errorMessage(error)),
            },
          );
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- Share */

type Expiry = '1' | '7' | '30';

/** Creates a public link to this recording; the link is shown once. */
function ShareDialog({
  projectId,
  recordingId,
  open,
  at,
  admin,
  onClose,
}: {
  projectId: string;
  recordingId: string;
  open: boolean;
  /** The playback time when the dialog was opened. */
  at: number;
  admin: boolean;
  onClose: () => void;
}) {
  const settings = useProjectSettings(projectId);
  const create = useCreateShare(projectId);
  const [expiry, setExpiry] = useState<Expiry>('7');
  /** Null until the switch is touched: on when the player is past the start. */
  const [fromHere, setFromHere] = useState<boolean | null>(null);
  const startHere = fromHere ?? at > 0;
  const created = create.data;

  const close = () => {
    onClose();
    setExpiry('7');
    setFromHere(null);
    create.reset();
  };

  const submit = () => {
    if (create.isPending) return;
    create.mutate({
      kind: 'recording',
      recordingId,
      startMs: startHere ? Math.round(at) : 0,
      expiresInDays: Number(expiry) as 1 | 7 | 30,
    });
  };

  let title = 'Share this recording';
  let description: ReactNode;
  let body: ReactNode = null;
  let footer: ReactNode = <Button onClick={close}>Close</Button>;

  if (created) {
    const link = created.link ?? '';
    title = 'Link created';
    description = 'Copy the link now. It is not shown again.';
    body = (
      <>
        <CodeBlock
          code={link.startsWith('/') ? `${window.location.origin}${link}` : link}
          label={`Expires ${day(created.expiresAt)}`}
        />
        <p className="text-hint text-fg-meta">You can revoke it in Settings → Sharing.</p>
      </>
    );
    footer = (
      <Button variant="primary" onClick={close}>
        Done
      </Button>
    );
  } else if (settings.isPending) {
    body = (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-3 w-56" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  } else if (settings.isError) {
    body = <ErrorNote error={settings.error} onRetry={() => void settings.refetch()} className="py-4" />;
  } else if (!settings.data.sharing.enabled) {
    description = admin
      ? 'Public links are off for this project.'
      : 'Public links are off for this project. Ask an admin to turn on public links.';
    if (admin) {
      footer = (
        <>
          <Button onClick={close}>Cancel</Button>
          <LinkButton variant="primary" to={`/projects/${projectId}/settings/sharing`}>
            Sharing settings
          </LinkButton>
        </>
      );
    }
  } else if (!admin) {
    description = 'Only admins can create public links.';
  } else {
    body = (
      <>
        <Field label="Expires in">
          <Select
            block
            label="Expires in"
            value={expiry}
            onChange={setExpiry}
            options={[
              { value: '1', label: '1 day' },
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
            ]}
          />
        </Field>
        <SwitchField
          label={`Start at ${duration(at)}`}
          checked={startHere}
          onChange={setFromHere}
        />
        <p className="text-hint text-fg-meta">
          Anyone with the link can watch this recording until it expires. Masked content stays
          masked.
        </p>
        <FormError message={create.error ? errorMessage(create.error) : null} />
      </>
    );
    footer = (
      <>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={create.isPending} onClick={submit}>
          Create link
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={title}
      description={description}
      footer={footer}
    >
      {body}
    </Dialog>
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

  const role = useMe().data?.user.role;
  const canWrite = role !== undefined && role !== 'viewer';
  const notes = useNotes(project.id, entry.id);
  const noteTimes = useMemo(() => (notes.data ?? []).map((note) => note.atMs), [notes.data]);

  const markedSeen = useRef(entry.seen);
  const replay = useReplay({
    events,
    data,
    live,
    startMs: Number(new URLSearchParams(window.location.search).get('t') ?? 0) * 1000,
    viewport: entry.viewport,
    onPlay: () => {
      if (markedSeen.current) return;
      markedSeen.current = true;
      update.mutate({ seen: true });
    },
  });
  const { time, playing, seek } = replay;

  const [theater, setTheater] = useState(false);
  const [tab, setTab] = useState<InspectorTab>('activity');
  const [onlyErrors, setOnlyErrors] = useState<'all' | 'errors'>('all');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [share, setShare] = useState({ open: false, at: 0 });

  const fallbackHost = project.origin.replace(/^https?:\/\//, '');
  const address = splitUrl(urlAt(data, time), fallbackHost, entry.entry);
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
              {visitorLabel(who)}
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
        <IconButton
          icon={Share2}
          label="Share"
          onClick={() => setShare({ open: true, at: time })}
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
          <ReplayAddress host={address.host} path={address.path} viewport={entry.viewport} />
          <ReplayStage
            replay={replay}
            pending={stream.isPending}
            error={stream.data ? null : stream.error}
            onRetry={() => void stream.refetch()}
          />
          <ReplayControls
            replay={replay}
            notes={noteTimes}
            trailing={
              <IconButton
                icon={theater ? Minimize2 : Maximize2}
                label={theater ? 'Show inspector' : 'Hide inspector'}
                onClick={() => setTheater((value) => !value)}
                className="max-lg:hidden"
              />
            }
          />
        </div>

        {theater ? null : (
          <aside className="flex max-h-[42vh] w-full shrink-0 flex-col border-t border-line bg-aside lg:max-h-none lg:w-[400px] lg:border-l lg:border-t-0">
            <div role="tablist" className="flex h-9 shrink-0 items-center gap-4 border-b border-line-subtle px-3.5">
              {(
                [
                  ['activity', 'Activity', data.activity.length],
                  ['console', 'Console', data.console.length],
                  ['network', 'Network', data.network.length],
                  ['notes', 'Notes', notes.data?.length || undefined],
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
                    '-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 text-control transition-colors',
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

              {tab === 'notes' ? (
                notes.isPending ? (
                  <div className="flex flex-col gap-3 px-3.5 py-3" aria-busy="true" aria-label="Loading">
                    <Skeleton className="h-3 w-48" />
                    <Skeleton className="h-3 w-36" />
                  </div>
                ) : notes.isError ? (
                  <ErrorNote error={notes.error} onRetry={() => void notes.refetch()} />
                ) : notes.data.length === 0 ? (
                  <Empty>
                    {canWrite
                      ? 'No notes yet. Add one to point a teammate at a moment.'
                      : 'Nobody has left a note on this recording.'}
                  </Empty>
                ) : (
                  <NoteList
                    projectId={project.id}
                    recordingId={entry.id}
                    notes={notes.data}
                    time={time}
                    onSeek={seek}
                    canDelete={canWrite}
                  />
                )
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
            {tab === 'notes' && canWrite ? (
              <NoteInput projectId={project.id} recordingId={entry.id} time={time} />
            ) : null}
          </aside>
        )}
      </div>

      <ShareDialog
        projectId={project.id}
        recordingId={entry.id}
        open={share.open}
        at={share.at}
        admin={canManage(role)}
        onClose={() => setShare((current) => ({ ...current, open: false }))}
      />

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
