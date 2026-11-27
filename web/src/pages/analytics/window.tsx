/** The time window shared by the errors, friction and performance pages. It lives in `?days=`. */
import { CalendarDays } from 'lucide-react';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Days } from '@/api/analytics';
import { Select } from '@/ui';

type Window = '7' | '14' | '30' | '90';

const WINDOWS: Window[] = ['7', '14', '30', '90'];
const DEFAULT_DAYS = 7;

/** The window from the query string and a way to change it; 7 days when absent or unknown. */
export function useDays() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('days');
  const days = (WINDOWS.find((option) => option === raw) ? Number(raw) : DEFAULT_DAYS) as Days;
  const setDays = useCallback(
    (next: Days) =>
      setParams(
        (current) => {
          const out = new URLSearchParams(current);
          if (next === DEFAULT_DAYS) out.delete('days');
          else out.set('days', String(next));
          return out;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [days, setDays] as const;
}

export function DaysPicker({ value, onChange }: { value: Days; onChange: (next: Days) => void }) {
  return (
    <Select
      label="Time range"
      value={String(value) as Window}
      onChange={(next) => onChange(Number(next) as Days)}
      icon={CalendarDays}
      className="w-28"
      options={WINDOWS.map((option) => ({ value: option, label: `${option} days` }))}
    />
  );
}

/** When the window began, to tell what first appeared inside it. */
export const windowStart = (days: Days) => Date.now() - days * 24 * 60 * 60 * 1000;
