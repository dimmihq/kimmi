import {
  ChevronLeft,
  ChevronRight,
  Mail,
  MailOpen,
  MessageSquare,
  MoreHorizontal,
  Play,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  type Feedback as FeedbackEntry,
  useDeleteFeedback,
  useFeedback,
  useSetFeedbackSeen,
} from '@/api/analytics';
import { errorMessage } from '@/api/http';
import { useMe } from '@/api/queries';
import { ago, clock } from '@/lib/format';
import { ErrorNote, SkeletonRows } from '@/shell/states';
import {
  cn,
  ConfirmDialog,
  EmptyState,
  IconButton,
  LinkButton,
  Menu,
  type MenuAction,
  Page,
  PageHeader,
  toast,
  Tooltip,
} from '@/ui';

const PER_PAGE = 25;

/** The recording of the visit that wrote it, opened ten seconds before they did. */
const watchHref = (projectId: string, entry: FeedbackEntry) =>
  `/projects/${projectId}/recordings/${entry.visitId}?t=${Math.max(0, Math.floor((entry.createdAt - entry.startedAt) / 1000) - 10)}`;

export function Feedback() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const page = Math.max(0, Number.parseInt(params.get('page') ?? '0', 10) || 0);
  const setPage = (next: number) =>
    setParams(
      (current) => {
        const out = new URLSearchParams(current);
        if (next === 0) out.delete('page');
        else out.set('page', String(next));
        return out;
      },
      { replace: true },
    );

  const role = useMe().data?.user.role;
  // Marking as read and deleting need a member or above.
  const canChange = role !== undefined && role !== 'viewer';

  const list = useFeedback(projectId, page);
  const setSeen = useSetFeedbackSeen(projectId);
  const remove = useDeleteFeedback(projectId);
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<FeedbackEntry | null>(null);

  const data = list.data;
  const total = data?.total ?? 0;
  const unseen = data?.unseen ?? 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const at = Math.min(page, pages - 1);
  const rows = data?.items ?? [];

  const mark = (entry: FeedbackEntry, seen: boolean) =>
    setSeen.mutate({ id: entry.id, seen }, { onError: (error) => toast(errorMessage(error)) });

  const toggle = (entry: FeedbackEntry) => {
    const opening = open !== entry.id;
    setOpen(opening ? entry.id : null);
    if (opening && !entry.seen && canChange) mark(entry, true);
  };

  const actionsFor = (entry: FeedbackEntry): MenuAction[] => {
    const actions: MenuAction[] = [];
    if (entry.recorded) {
      actions.push({
        id: 'watch',
        label: 'Watch the session',
        icon: Play,
        onSelect: () => navigate(watchHref(projectId, entry)),
      });
    }
    if (canChange) {
      actions.push(
        {
          id: 'seen',
          label: entry.seen ? 'Mark as unread' : 'Mark as read',
          icon: entry.seen ? Mail : MailOpen,
          onSelect: () => mark(entry, !entry.seen),
        },
        {
          id: 'delete',
          label: 'Delete',
          icon: Trash2,
          tone: 'danger',
          separated: true,
          onSelect: () => setDeleting(entry),
        },
      );
    }
    return actions;
  };

  return (
    <Page>
      <PageHeader
        title="Feedback"
        description={
          unseen > 0
            ? `What visitors wrote to you · ${unseen} unread`
            : 'What visitors wrote to you'
        }
      />

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex h-[38px] items-center gap-4 border-b border-line-subtle px-4 text-label text-fg-meta">
          <span className="min-w-0 flex-1 pl-[18px]">Message</span>
          <span className="hidden w-52 shrink-0 md:block">Email</span>
          <span className="w-20 shrink-0 text-right">Sent</span>
          <span className="w-[30px] shrink-0" />
        </div>

        {list.isPending ? (
          <SkeletonRows count={8} />
        ) : !data ? (
          <ErrorNote error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No feedback yet"
            description={
              <>
                Turn on the feedback button in the analytics settings, or call{' '}
                <code className="font-mono text-mono text-fg-secondary">kimmi.feedback('...')</code>{' '}
                from your own form. Each message arrives here with the recording it was written in.
              </>
            }
            action={
              <LinkButton to={`/projects/${projectId}/settings/analytics`}>
                Analytics settings
              </LinkButton>
            }
          />
        ) : (
          rows.map((entry) => {
            const expanded = open === entry.id;
            const actions = actionsFor(entry);
            return (
              <div
                key={entry.id}
                className="flex items-start gap-4 border-b border-line-subtle px-4 py-2.5 transition-colors duration-75 hover:bg-hover"
              >
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggle(entry)}
                  className="flex min-w-0 flex-1 items-start gap-3 rounded-sm text-left"
                >
                  <span
                    className={cn(
                      'mt-[7px] size-1.5 shrink-0 rounded-full',
                      entry.seen ? 'bg-transparent' : 'bg-brand',
                    )}
                  >
                    {entry.seen ? null : <span className="sr-only">Unread</span>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block whitespace-pre-wrap break-words text-body',
                        !expanded && 'line-clamp-3',
                        entry.seen ? 'text-fg-secondary' : 'font-semibold text-fg',
                      )}
                    >
                      {entry.body}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[0.65rem] text-fg-ghost">
                      {entry.path}
                    </span>
                    {entry.email ? (
                      <span className="mt-0.5 block truncate text-hint text-fg-meta md:hidden">
                        {entry.email}
                      </span>
                    ) : null}
                  </span>
                </button>
                <span className="hidden h-[30px] w-52 shrink-0 items-center md:flex">
                  {entry.email ? (
                    <a
                      href={`mailto:${entry.email}`}
                      className="truncate text-control text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                    >
                      {entry.email}
                    </a>
                  ) : (
                    <span className="text-control text-fg-ghost">No email</span>
                  )}
                </span>
                <Tooltip label={clock(entry.createdAt)}>
                  <span className="tabular flex h-[30px] w-20 shrink-0 items-center justify-end text-control text-fg-meta">
                    {ago(entry.createdAt)}
                  </span>
                </Tooltip>
                <span className="w-[30px] shrink-0">
                  {actions.length > 0 ? (
                    <Menu
                      align="end"
                      trigger={<IconButton icon={MoreHorizontal} label="Feedback actions" />}
                      actions={actions}
                    />
                  ) : null}
                </span>
              </div>
            );
          })
        )}

        <div className="flex h-11 items-center justify-between px-4 text-control text-fg-meta">
          <span className="tabular">
            {total === 0
              ? '0 messages'
              : `${at * PER_PAGE + 1}–${Math.min(total, (at + 1) * PER_PAGE)} of ${total}`}
          </span>
          <span className="flex items-center gap-1">
            <IconButton
              icon={ChevronLeft}
              label="Previous page"
              disabled={at === 0}
              onClick={() => setPage(at - 1)}
            />
            <span className="tabular px-1">
              {at + 1} / {pages}
            </span>
            <IconButton
              icon={ChevronRight}
              label="Next page"
              disabled={at >= pages - 1}
              onClick={() => setPage(at + 1)}
            />
          </span>
        </div>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title="Delete feedback"
        description="The message is deleted for everyone. The recording it was written in stays. This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => toast('Feedback deleted'),
            onError: (error) => toast(errorMessage(error)),
          });
        }}
      />
    </Page>
  );
}
