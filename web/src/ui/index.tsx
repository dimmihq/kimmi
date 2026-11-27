import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { Select as BaseSelect } from '@base-ui/react/select';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import clsx, { type ClassValue } from 'clsx';
import { Check, ChevronsUpDown, Copy, type LucideIcon, X } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link, type LinkProps } from 'react-router-dom';

export const cn = (...values: ClassValue[]) => clsx(values);

/* ------------------------------------------------------------------ Button */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  className?: string,
) {
  return cn(
    'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-control transition-colors duration-100 disabled:opacity-50',
    size === 'sm' && 'h-[30px] px-2.5',
    size === 'md' && 'h-8 px-3',
    size === 'lg' && 'h-9 px-4',
    variant === 'primary' &&
      'bg-brand text-brand-ink hover:bg-brand-hover font-semibold',
    variant === 'secondary' &&
      'border border-line-field bg-hover text-fg-secondary hover:bg-active hover:text-fg',
    variant === 'ghost' && 'text-fg-muted hover:bg-hover hover:text-fg',
    variant === 'danger' &&
      'border border-danger/40 bg-danger-soft text-danger-fg hover:bg-danger/25',
    className,
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
}

export function Button({
  variant,
  size,
  icon: Icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, className)}
      {...rest}
    >
      {Icon ? <Icon className="size-3.5" strokeWidth={2} /> : null}
      {children}
    </button>
  );
}

export function LinkButton({
  variant,
  size,
  icon: Icon,
  className,
  children,
  ...rest
}: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: LucideIcon }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {Icon ? <Icon className="size-3.5" strokeWidth={2} /> : null}
      {children}
    </Link>
  );
}

export function IconButton({
  icon: Icon,
  label,
  className,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  active?: boolean;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        className={cn(
          'inline-flex size-[30px] shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-100 hover:bg-hover hover:text-fg disabled:opacity-40',
          active && 'bg-active text-fg',
          className,
        )}
        {...rest}
      >
        <Icon className="size-[15px]" strokeWidth={1.9} />
      </button>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ Fields */

export function Input({
  className,
  icon: Icon,
  mono,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { icon?: LucideIcon; mono?: boolean }) {
  const field = (
    <input
      className={cn(
        'h-8 w-full rounded-md border border-line-field bg-canvas px-2.5 text-control text-fg placeholder:text-fg-ghost transition-colors hover:border-line-strong focus:border-brand focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50',
        Icon && 'pl-8',
        mono && 'font-mono text-mono',
        className,
      )}
      {...rest}
    />
  );
  if (!Icon) return field;
  return (
    <div className="relative w-full">
      <Icon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-meta" />
      {field}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-label text-fg-secondary">{label}</span>
      {children}
      {hint ? <span className="text-hint text-fg-meta">{hint}</span> : null}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      disabled={disabled}
      className="relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-line-strong outline-offset-2 transition-colors duration-75 active:scale-90 data-[checked]:bg-brand data-[disabled]:opacity-50"
    >
      <BaseSwitch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-fg-secondary shadow-raised transition-[translate,background-color] duration-100 ease-standard data-[checked]:translate-x-4 data-[checked]:bg-brand-ink" />
    </BaseSwitch.Root>
  );
}

export interface Option<T extends string = string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  icon: Icon,
  className,
  size = 'md',
  block,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Option<T>[];
  label: string;
  icon?: LucideIcon;
  className?: string;
  size?: 'sm' | 'md';
  /** Fill the column, drawn like a field: for a settings row or a form. */
  block?: boolean;
}) {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => onChange(next as T)}
      items={options}
    >
      <BaseSelect.Trigger
        aria-label={label}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-line-field px-2.5 text-control transition-colors',
          block
            ? 'flex w-full bg-canvas text-fg hover:border-line-strong data-[popup-open]:border-line-strong'
            : 'bg-hover text-fg-secondary hover:bg-active hover:text-fg data-[popup-open]:bg-active',
          size === 'sm' ? 'h-[30px]' : 'h-8',
          className,
        )}
      >
        {Icon ? <Icon className="size-3.5 text-fg-meta" /> : null}
        <BaseSelect.Value className="flex-1 truncate text-left" />
        <BaseSelect.Icon>
          <ChevronsUpDown className="size-3 text-fg-meta" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-50">
          <BaseSelect.Popup className="min-w-[var(--anchor-width)] origin-[var(--transform-origin)] animate-drop-in rounded-lg border border-line-field bg-floating p-1 shadow-overlay outline-none">
            {options.map((option) => (
              <BaseSelect.Item
                key={option.value}
                value={option.value}
                className="flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-control text-fg-secondary outline-none data-[highlighted]:bg-active data-[highlighted]:text-fg"
              >
                {option.icon ? <option.icon className="size-3.5 text-fg-meta" /> : null}
                <BaseSelect.ItemText className="flex-1">{option.label}</BaseSelect.ItemText>
                <BaseSelect.ItemIndicator>
                  <Check className="size-3.5 text-brand-fg" />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Option<T>[];
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex h-8 items-center gap-0.5 rounded-md border border-line bg-hover p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'inline-flex h-full items-center gap-1.5 rounded-[5px] px-2.5 text-control transition-colors duration-100',
            option.value === value
              ? 'bg-active text-fg shadow-raised'
              : 'text-fg-meta hover:text-fg-secondary',
          )}
        >
          {option.icon ? <option.icon className="size-3.5" /> : null}
          {option.label}
        </button>
      ))}
    </div>
  );
}


/* ------------------------------------------------------------------- Small */

type Tone = 'neutral' | 'brand' | 'danger' | 'warning' | 'info';

export function Tag({
  tone = 'neutral',
  children,
  icon: Icon,
  className,
  dot,
}: {
  tone?: Tone;
  children: ReactNode;
  icon?: LucideIcon;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 text-hint font-medium',
        tone === 'neutral' && 'bg-chip text-fg-muted',
        tone === 'brand' && 'bg-brand-soft text-brand-fg',
        tone === 'danger' && 'bg-danger-soft text-danger-fg',
        tone === 'warning' && 'bg-warning-soft text-warning-fg',
        tone === 'info' && 'bg-info-soft text-info-fg',
        className,
      )}
    >
      {dot ? <span className="size-1.5 animate-pulse-dot rounded-full bg-current" /> : null}
      {Icon ? <Icon className="size-3" strokeWidth={2} /> : null}
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-line bg-hover px-1 font-sans text-badge font-medium text-fg-meta">
      {children}
    </kbd>
  );
}

export function Avatar({
  name,
  size = 26,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const initials = name
    .replace(/[^a-zA-Z ]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-active font-semibold text-fg-secondary',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.38) }}
    >
      {initials || '?'}
    </span>
  );
}

export function Tooltip({
  label,
  children,
  side = 'top',
}: {
  label: ReactNode;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-[60]">
          <BaseTooltip.Popup className="animate-swap-in rounded-md border border-line-field bg-tooltip px-2 py-1 text-hint font-medium text-[oklch(0.96_0_0)] shadow-overlay">
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

export const TooltipProvider = BaseTooltip.Provider;

/* -------------------------------------------------------------------- Menu */

export interface MenuAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  leading?: ReactNode;
  tone?: 'danger';
  separated?: boolean;
  selected?: boolean;
  hint?: string;
  onSelect?: () => void;
}

export function Menu({
  trigger,
  actions,
  align = 'start',
  className,
}: {
  trigger: ReactElement;
  actions: MenuAction[];
  align?: 'start' | 'end' | 'center';
  className?: string;
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={6} align={align} className="z-50">
          <BaseMenu.Popup
            className={cn(
              'min-w-44 origin-[var(--transform-origin)] animate-drop-in rounded-lg border border-line-field bg-floating p-1 shadow-overlay outline-none',
              className,
            )}
          >
            {actions.map((action) => (
              <div key={action.id}>
                {action.separated ? <div className="mx-1 my-1 h-px bg-line" /> : null}
                <BaseMenu.Item
                  onClick={action.onSelect}
                  className={cn(
                    'flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-control outline-none data-[highlighted]:bg-active',
                    action.tone === 'danger'
                      ? 'text-danger-fg'
                      : 'text-fg-secondary data-[highlighted]:text-fg',
                  )}
                >
                  {action.leading}
                  {action.icon ? <action.icon className="size-3.5 opacity-80" /> : null}
                  <span className="flex-1 truncate">{action.label}</span>
                  {action.hint ? (
                    <span className="text-hint text-fg-meta">{action.hint}</span>
                  ) : null}
                  {action.selected ? <Check className="size-3.5 text-brand-fg" /> : null}
                </BaseMenu.Item>
              </div>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

/* ------------------------------------------------------------------ Dialog */

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 420,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <BaseDialog.Popup
          style={{ width }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-48px)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-dialog outline-none transition-[opacity,scale] duration-100 data-[ending-style]:scale-[0.97] data-[starting-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        >
          <div className="flex shrink-0 items-start gap-3 px-[22px] pb-4 pt-5">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
              <BaseDialog.Title className="text-section text-fg">{title}</BaseDialog.Title>
              {description ? (
                <BaseDialog.Description className="text-body text-fg-tertiary">
                  {description}
                </BaseDialog.Description>
              ) : null}
            </div>
            <BaseDialog.Close
              aria-label="Close"
              className="flex size-[26px] shrink-0 items-center justify-center rounded-sm text-fg-meta hover:bg-hover hover:text-fg"
            >
              <X className="size-3.5" />
            </BaseDialog.Close>
          </div>
          {children ? (
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-[22px] pb-5">
              {children}
            </div>
          ) : null}
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line-subtle bg-hover px-[22px] py-4">
            {footer}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  danger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  danger?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

/** A switch inside a form: what it does on the left, the switch on the right. */
export function SwitchField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-label text-fg-secondary">{label}</span>
        <Switch checked={checked} onChange={onChange} label={label} />
      </div>
      {hint ? <p className="mt-1.5 text-hint text-fg-meta">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Layout */

export function Panel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('rounded-xl border border-line bg-surface', className)}>
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start gap-3 px-4 pb-3 pt-3.5">
      <div className="min-w-0 flex-1">
        <h3 className="text-card-title text-fg">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-hint text-fg-meta">{description}</p>
        ) : null}
      </div>
      {action}
    </header>
  );
}

export function Page({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
  width?: 'wide' | 'narrow';
}) {
  return (
    <div className={cn('mx-auto w-full max-w-[1320px] px-4 pb-16 pt-7 md:px-7', className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  leading,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start gap-x-4 gap-y-3">
      {leading}
      <div className="min-w-0 flex-1">
        <h1 className="text-page-title text-fg">{title}</h1>
        {description ? (
          <p className="mt-1 text-body text-fg-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Figure({
  label,
  value,
  detail,
  delta,
  deltaTone = 'neutral',
  children,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  delta?: string;
  deltaTone?: 'good' | 'bad' | 'neutral';
  children?: ReactNode;
}) {
  return (
    <Panel className="flex min-h-[104px] flex-col px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-label text-fg-muted">{label}</span>
        {delta ? (
          <span
            className={cn(
              'tabular text-hint font-medium',
              deltaTone === 'good' && 'text-brand-fg',
              deltaTone === 'bad' && 'text-danger-fg',
              deltaTone === 'neutral' && 'text-fg-meta',
            )}
          >
            {delta}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <div className="tabular text-numeric-lg text-fg">{value}</div>
          {detail ? <div className="mt-1.5 text-hint text-fg-meta">{detail}</div> : null}
        </div>
        {children}
      </div>
    </Panel>
  );
}

/** Tiny bar chart: the sparkline beside a figure or in a table row. */
export function Bars({
  values,
  height = 28,
  tone = 'brand',
  className,
  barWidth = 3,
}: {
  values: number[];
  height?: number;
  tone?: 'brand' | 'muted' | 'danger';
  className?: string;
  barWidth?: number;
}) {
  const max = Math.max(1, ...values);
  return (
    <div
      className={cn('flex items-end gap-[2px]', className)}
      style={{ height }}
      aria-hidden="true"
    >
      {values.map((value, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed series
          key={index}
          className={cn(
            'rounded-[1px]',
            tone === 'brand' && 'bg-brand',
            tone === 'muted' && 'bg-bar-muted',
            tone === 'danger' && 'bg-danger',
          )}
          style={{
            width: barWidth,
            height: Math.max(2, Math.round((value / max) * height)),
            opacity: tone === 'brand' ? 0.55 + 0.45 * (value / max) : 1,
          }}
        />
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <span className="mb-4 flex size-10 items-center justify-center rounded-xl border border-line bg-hover text-fg-muted">
        <Icon className="size-[18px]" strokeWidth={1.8} />
      </span>
      <h3 className="text-section text-fg">{title}</h3>
      <p className="mt-1 max-w-sm text-body text-fg-muted">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/** Underlined tabs: the views of one list. */
export function Tabs<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string; count?: number }[];
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex items-center gap-5 border-b border-line-subtle">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(option.value)}
            className={cn(
              '-mb-px flex h-9 items-center gap-1.5 border-b-2 text-control transition-colors duration-100',
              on
                ? 'border-brand text-fg'
                : 'border-transparent text-fg-meta hover:text-fg-secondary',
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className="tabular text-hint text-fg-ghost">{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- Settings */

/** The head of a settings page: title, one line of what it is, actions. */
export function SettingsHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-4 border-b border-line-subtle pb-6">
      <div className="min-w-0">
        <h1 className="truncate text-page-title text-fg">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-value text-fg-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SettingSection({
  title,
  description,
  children,
  actions,
  destructive,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  destructive?: boolean;
}) {
  return (
    <section className="mt-7 first:mt-0">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className={cn('text-card-title', destructive ? 'text-danger-fg' : 'text-fg')}>
            {title}
          </h2>
          {description ? (
            <p className="mt-1 max-w-2xl text-meta text-fg-meta">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div
        className={cn(
          'mt-3 overflow-hidden rounded-2xl border bg-surface',
          destructive ? 'border-danger-soft' : 'border-line-subtle',
        )}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * One setting: what it is on the left, its control in a fixed column on the
 * right. Below a comfortable width the control drops under the text.
 */
export function SettingRow({
  title,
  description,
  children,
  wide,
  htmlFor,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  wide?: boolean;
  htmlFor?: string;
}) {
  return (
    <div className="@container border-b border-line-subtle px-5 py-4 last:border-b-0">
      <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between @xl:gap-8">
        <div className="min-w-0 @xl:max-w-xs">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="cursor-pointer text-value font-medium text-fg">
              {title}
            </label>
          ) : (
            <p className="text-value font-medium text-fg">{title}</p>
          )}
          {description ? <p className="mt-1 text-hint text-fg-meta">{description}</p> : null}
        </div>
        {children ? (
          <div className={cn('shrink-0', wide ? '@xl:w-[416px] @xl:shrink' : '@xl:w-72')}>
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A row of a settings list: a member, a token, a session. */
export function SettingsListItem({
  leading,
  title,
  description,
  meta,
  actions,
}: {
  leading?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 border-b border-line-subtle px-5 py-3 last:border-b-0">
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2 truncate text-value font-medium text-fg">
          {title}
        </div>
        {description ? (
          <div className="min-w-0 truncate text-hint text-fg-meta">{description}</div>
        ) : null}
      </div>
      {meta ? (
        <div className="hidden shrink-0 items-center gap-3 text-meta text-fg-meta sm:flex">
          {meta}
        </div>
      ) : null}
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

export function SettingsEmpty({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-12 text-center">
      {Icon ? <Icon className="mb-2 size-4 text-fg-ghost" /> : null}
      <p className="text-value font-medium text-fg">{title}</p>
      {description ? <p className="max-w-sm text-meta text-fg-meta">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/**
 * A text setting saves itself when you leave the field or press Enter, the
 * way every text setting in the product does. There is no Save button.
 */
export function SavableInput({
  value,
  onSave,
  saved = 'Saved',
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onSave: (next: string) => void;
  saved?: string;
  mono?: boolean;
  icon?: LucideIcon;
}) {
  const [draft, setDraft] = useState(value);
  const [last, setLast] = useState(value);
  if (last !== value) {
    setLast(value);
    setDraft(value);
  }
  return (
    <Input
      {...rest}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) {
          onSave(draft);
          toast(saved);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setDraft(value);
      }}
    />
  );
}

/* -------------------------------------------------------------------- Code */

export function CodeBlock({
  code,
  children,
  label,
}: {
  code: string;
  children?: ReactNode;
  label?: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-canvas">
      <div className="flex h-9 items-center justify-between border-b border-line-subtle pl-3 pr-1.5">
        <span className="font-mono text-mono text-fg-meta">{label}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            toast('Copied to clipboard');
          }}
          className="inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-hint font-medium text-fg-muted hover:bg-hover hover:text-fg"
        >
          <Copy className="size-3" />
          Copy
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 font-mono text-mono leading-[1.7] text-fg-secondary">
        {children ?? code}
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------- Toast */

let toasts: { id: number; text: string }[] = [];
const listeners = new Set<() => void>();
let nextToast = 1;

export function toast(text: string) {
  const id = nextToast++;
  toasts = [...toasts, { id, text }];
  for (const listener of listeners) listener();
  setTimeout(() => {
    toasts = toasts.filter((entry) => entry.id !== id);
    for (const listener of listeners) listener();
  }, 2400);
}

export function Toaster() {
  const entries = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
  );
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[70] flex flex-col items-end gap-2">
      {entries.map((entry) => (
        <div
          key={entry.id}
          role="status"
          className="flex animate-rise items-center gap-2 rounded-lg border border-line-field bg-tooltip px-3 py-2 text-control text-[oklch(0.96_0_0)] shadow-overlay"
        >
          <Check className="size-3.5 text-brand" />
          {entry.text}
        </div>
      ))}
    </div>
  );
}
