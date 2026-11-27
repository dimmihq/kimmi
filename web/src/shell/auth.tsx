/** The split layout shared by log in, sign up and accept invite. */
import { Eye, EyeOff, MousePointer2 } from 'lucide-react';
import { type InputHTMLAttributes, type ReactNode, useState } from 'react';
import { Input } from '@/ui';
import { Mark, Wordmark } from './AppFrame';
import { DOCS_URL } from './nav';

/** Where a signed-out visitor was headed, kept in the router state of /login. */
export interface ReturnState {
  from?: { pathname: string; search: string };
}

export const returnPath = (state: unknown) => {
  const from = (state as ReturnState | null)?.from;
  return from ? `${from.pathname}${from.search}` : '/projects';
};

/** A small looping replay: the product, drawn instead of described. */
function ReplayScene() {
  return (
    <div className="relative w-[440px] max-w-full">
      <style>{`
        @keyframes scene-cursor {
          0%, 8% { transform: translate(60px, 210px); }
          26%, 34% { transform: translate(292px, 96px); }
          52%, 60% { transform: translate(120px, 150px); }
          78%, 88% { transform: translate(318px, 214px); }
          100% { transform: translate(60px, 210px); }
        }
        @keyframes scene-click {
          0%, 26% { opacity: 0; transform: scale(0.4); }
          29% { opacity: 0.9; transform: scale(1); }
          36%, 78% { opacity: 0; transform: scale(1.6); }
          81% { opacity: 0.9; transform: scale(1); }
          90%, 100% { opacity: 0; transform: scale(1.6); }
        }
        @keyframes scene-head { from { left: 0%; } to { left: 100%; } }
        @keyframes scene-fill { from { width: 0%; } to { width: 100%; } }
      `}</style>
      <div className="overflow-hidden rounded-2xl border border-line-field bg-surface shadow-dialog">
        <div className="flex h-8 items-center gap-1.5 border-b border-line px-3">
          <span className="size-2 rounded-full bg-active" />
          <span className="size-2 rounded-full bg-active" />
          <span className="size-2 rounded-full bg-active" />
          <span className="ml-3 h-4 flex-1 rounded bg-hover" />
        </div>
        <div className="relative h-[260px] bg-stage p-5">
          <div className="flex items-center justify-between">
            <span className="h-3 w-20 rounded bg-active" />
            <span className="flex gap-2">
              <span className="h-3 w-10 rounded bg-hover" />
              <span className="h-3 w-10 rounded bg-hover" />
              <span className="h-3 w-12 rounded bg-brand/70" />
            </span>
          </div>
          <div className="mt-7 h-5 w-48 rounded bg-active" />
          <div className="mt-2.5 h-3 w-64 rounded bg-hover" />
          <div className="mt-6 grid grid-cols-3 gap-3">
            {[0, 1, 2].map((card) => (
              <div key={card} className="rounded-lg border border-line bg-surface p-2.5">
                <div className="h-14 rounded bg-hover" />
                <div className="mt-2 h-2.5 w-14 rounded bg-active" />
                <div className="mt-1.5 h-2.5 w-9 rounded bg-hover" />
              </div>
            ))}
          </div>
          <div
            className="pointer-events-none absolute left-0 top-0"
            style={{ animation: 'scene-cursor 9s cubic-bezier(0.4,0,0.2,1) infinite' }}
          >
            <span
              className="absolute -left-3 -top-3 size-7 rounded-full border-2 border-brand"
              style={{ animation: 'scene-click 9s linear infinite' }}
            />
            <MousePointer2 className="size-5 fill-fg text-canvas" strokeWidth={1.5} />
          </div>
        </div>
        <div className="flex h-11 items-center gap-3 border-t border-line px-3.5">
          <span className="flex size-5 items-center justify-center rounded-full bg-brand">
            <span className="ml-px size-0 border-y-[4px] border-l-[6px] border-y-transparent border-l-brand-ink" />
          </span>
          <div className="relative h-1 flex-1 rounded-full bg-active">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-brand"
              style={{ animation: 'scene-fill 18s linear infinite' }}
            />
            <span className="absolute -top-1 left-[26%] h-3 w-px bg-warning" />
            <span className="absolute -top-1 left-[58%] h-3 w-px bg-danger" />
            <span
              className="absolute -top-1 size-3 -translate-x-1/2 rounded-full border-2 border-canvas bg-fg"
              style={{ animation: 'scene-head 18s linear infinite' }}
            />
          </div>
          <span className="font-mono text-mono text-fg-meta">2:14</span>
        </div>
      </div>
    </div>
  );
}

/** The scene on the left, the form (or a message) on the right. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full bg-canvas lg:grid-cols-2">
      <aside className="relative m-2 hidden flex-col overflow-hidden rounded-2xl border border-line bg-panel lg:flex">
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-70"
          style={{
            background:
              'radial-gradient(520px 380px at 50% 42%, oklch(0.91 0.18 127 / 0.07), transparent 70%)',
          }}
        />
        <div className="relative flex flex-1 items-center justify-center p-10">
          <ReplayScene />
        </div>
        <div className="relative p-9 pt-0">
          <h2 className="text-title text-fg">See what your visitors saw.</h2>
          <p className="mt-1.5 text-body text-fg-muted">
            Self-hosted session replay. One binary, your infrastructure, your data.
          </p>
        </div>
      </aside>

      <main className="flex flex-col px-6">
        <div className="flex flex-1 items-center justify-center">{children}</div>
        <nav className="flex justify-center gap-3 pb-7 text-meta text-fg-meta">
          <a href={DOCS_URL} className="hover:text-fg">Docs</a>
          <span>·</span>
          <a href="https://github.com" className="hover:text-fg">GitHub</a>
        </nav>
      </main>
    </div>
  );
}

/** The heading block above every auth form, with the mark on small screens. */
export function AuthHeading({ title, description }: { title: string; description: ReactNode }) {
  return (
    <>
      <div className="mb-8 flex items-center gap-2.5 lg:hidden">
        <Mark size={24} />
        <Wordmark height={18} />
      </div>
      <h1 className="text-title text-fg">{title}</h1>
      <p className="mb-7 mt-1 text-body text-fg-muted">{description}</p>
    </>
  );
}

export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={shown ? 'text' : 'password'} className="h-9 pr-9" />
      <button
        type="button"
        aria-label={shown ? 'Hide password' : 'Show password'}
        onClick={() => setShown((value) => !value)}
        className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-fg-meta hover:text-fg"
      >
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
  );
}
