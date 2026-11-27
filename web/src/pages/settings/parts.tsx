/** Loading, error and saving pieces shared by every settings page. */
import type { LucideIcon } from 'lucide-react';
import { type InputHTMLAttributes, type ReactNode, useId, useState } from 'react';
import { ApiError, errorMessage } from '@/api/http';
import { Button, cn, Input, SettingSection, toast } from '@/ui';

/** Toasts the server's message for a failed change. */
export const failed = (error: unknown) => toast(errorMessage(error));

/** The message for one field of a failed request, or the request's message. */
export const fieldError = (error: unknown, field: string) =>
  error instanceof ApiError ? (error.fields[field] ?? error.message) : errorMessage(error);

/** A muted bar standing in for content that is loading. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('block animate-pulse rounded-md bg-chip', className)} />;
}

/** Where a control sits while its value loads, the same size as the control. */
export function ControlSkeleton({ kind = 'field' }: { kind?: 'field' | 'switch' }) {
  return kind === 'switch' ? (
    <Skeleton className="h-[18px] w-8 rounded-full" />
  ) : (
    <Skeleton className="h-8 w-full" />
  );
}

/** Renders the control once its value is there, a skeleton until then. */
export function Loaded<T>({
  value,
  kind,
  children,
}: {
  value: T | undefined;
  kind?: 'field' | 'switch';
  children: (value: T) => ReactNode;
}) {
  return value === undefined ? <ControlSkeleton kind={kind} /> : children(value);
}

/** Rows of a settings list while it loads, shaped like the real rows. */
export function SkeletonItems({ count = 3, round }: { count?: number; round?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
          key={index}
          className="flex min-h-12 items-center gap-3 border-b border-line-subtle px-5 py-3 last:border-b-0"
        >
          <Skeleton className={cn('size-7 shrink-0', round && 'rounded-full')} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
            <Skeleton className="h-3.5 w-48 max-w-full" />
            <Skeleton className="h-3 w-32 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A failed load, inside the panel that would have shown it. */
export function InlineError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 px-5 py-4">
      <p className="min-w-0 text-meta text-danger-fg">{errorMessage(error)}</p>
      <Button size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** A page whose data failed to load: its first section holds the error. */
export function SectionError({
  title,
  description,
  error,
  onRetry,
}: {
  title: string;
  description?: ReactNode;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <SettingSection title={title} description={description}>
      <InlineError error={error} onRetry={onRetry} />
    </SettingSection>
  );
}

/**
 * A text setting that saves on blur or Enter, like SavableInput, but waits
 * for the server: "Saved" on success, the server's message under the field
 * on failure (the draft stays so it can be corrected; Escape restores it).
 */
export function SavingInput({
  value,
  onSave,
  field,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onSave: (next: string) => Promise<unknown>;
  /** The request field whose error belongs under this input. */
  field?: string;
  mono?: boolean;
  icon?: LucideIcon;
}) {
  const [draft, setDraft] = useState(value);
  const [last, setLast] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  if (last !== value) {
    setLast(value);
    setDraft(value);
  }

  const save = async () => {
    if (draft === value) return;
    try {
      await onSave(draft);
      setError(null);
      toast('Saved');
    } catch (failure) {
      setError(field ? fieldError(failure, field) : errorMessage(failure));
    }
  };

  return (
    <>
      <Input
        {...rest}
        value={draft}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(value);
            setError(null);
          }
        }}
      />
      {error ? (
        <p id={errorId} className="mt-1.5 text-hint text-danger-fg">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Keeps a select showing a stored value that is not one of its choices. */
export function withValue<T extends string>(
  options: { value: T; label: string }[],
  value: T,
  label: string,
) {
  return options.some((option) => option.value === value) ? options : [...options, { value, label }];
}
