/** Loading and error states, drawn in the same panels as the content they stand in for. */
import { TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { ApiError, errorMessage } from '@/api/http';
import { Button, cn } from '@/ui';

/** A muted bar where text or a figure is about to appear. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('block animate-pulse rounded bg-active', className)} />;
}

/** Rows of a list while it loads: same height as the real rows. */
export function SkeletonRows({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
          key={index}
          className={cn(
            'flex h-12 items-center gap-3 border-b border-line-subtle px-4 last:border-b-0',
            className,
          )}
        >
          <Skeleton className="size-[26px] rounded-full" />
          <Skeleton className="h-3 w-40" />
          <span className="flex-1" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

/** A failed load inside its panel: what went wrong and a way to try again. */
export function ErrorNote({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center justify-center gap-x-3 gap-y-2 px-4 py-10 text-center text-body text-fg-meta',
        className,
      )}
    >
      <TriangleAlert className="size-4 shrink-0 text-danger-fg" />
      <span>{errorMessage(error)}</span>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Splits a failed form submit into the per-field messages and one general line. */
export function formErrors(error: unknown): { fields: Record<string, string>; message: string | null } {
  if (!error) return { fields: {}, message: null };
  const fields = error instanceof ApiError ? error.fields : {};
  return { fields, message: Object.keys(fields).length > 0 ? null : errorMessage(error) };
}

/** The message under a field, in the hint slot. */
export function fieldHint(error: string | undefined, hint?: ReactNode) {
  return error ? <span className="text-danger-fg">{error}</span> : hint;
}

/** The general error line above a form's button. */
export function FormError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-hint text-danger-fg">
      {message}
    </p>
  ) : null;
}

/** `value`, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** The current time, ticking every `ms`. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
