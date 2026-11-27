// The feedback button, built apart from kimmi.js and loaded by `kimmi.showFeedback()`.
// It talks to the SDK through `window.__kimmiFeedback`, set right before this script is added.

interface Bridge {
  send(text: string, email?: string): void;
  labels?: Partial<typeof defaults>;
}

const defaults = {
  button: 'Feedback',
  title: 'Send feedback',
  text: 'What is on your mind?',
  email: 'Email (optional)',
  cancel: 'Cancel',
  send: 'Send',
  thanks: 'Thanks for your feedback.',
};

const css = `
:host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483000;color-scheme:light dark;
--bg:#fff;--fg:#1a1a1a;--line:#d4d4d4;--muted:#666;--accent:#1a1a1a;--on:#fff;
font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media(prefers-color-scheme:dark){:host{--bg:#1f1f1f;--fg:#f2f2f2;--line:#444;--muted:#aaa;--accent:#f2f2f2;--on:#1a1a1a}}
*{box-sizing:border-box;font:inherit}
button{cursor:pointer;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);padding:6px 12px}
button:focus-visible,textarea:focus-visible,input:focus-visible{outline:2px solid var(--fg);outline-offset:1px}
.open{box-shadow:0 1px 4px rgba(0,0,0,.2)}
.send{background:var(--accent);color:var(--on);border-color:var(--accent)}
.panel{position:absolute;right:0;bottom:0;width:300px;max-width:calc(100vw - 32px);padding:12px;border-radius:8px;
border:1px solid var(--line);background:var(--bg);color:var(--fg);box-shadow:0 4px 16px rgba(0,0,0,.2)}
h2{margin:0 0 8px;font-size:14px;font-weight:600}
textarea,input{display:block;width:100%;margin:0 0 8px;padding:6px 8px;border-radius:6px;border:1px solid var(--line);
background:var(--bg);color:var(--fg)}
textarea{height:96px;resize:vertical}
::placeholder{color:var(--muted)}
.row{display:flex;justify-content:flex-end;gap:8px}
p{margin:8px 0;text-align:center}
[hidden]{display:none}
`;

function mount(bridge: Bridge): void {
  const labels = { ...defaults, ...bridge.labels };
  const host = document.createElement('div');
  // kimmi-ignore: what is typed here is not recorded.
  host.className = 'kimmi-ignore';
  // Clicks on kimmi's own button are not the site's: heatmaps and rage clicks skip them.
  host.setAttribute('data-kimmi-own', '');
  const root = host.attachShadow({ mode: 'open' });

  const el = <T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, children: Node[] = []): T => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node as T;
  };

  const style = el('style', { textContent: css });
  const open = el('button', { type: 'button', className: 'open', textContent: labels.button });
  const title = el('h2', { id: 'title', textContent: labels.title });
  const text = el<HTMLTextAreaElement>('textarea', { className: 'kimmi-ignore', placeholder: labels.text, required: true, maxLength: 2000 });
  text.setAttribute('aria-label', labels.text);
  const email = el<HTMLInputElement>('input', { className: 'kimmi-ignore', type: 'email', placeholder: labels.email, maxLength: 200, autocomplete: 'email' });
  email.setAttribute('aria-label', labels.email);
  const cancel = el('button', { type: 'button', textContent: labels.cancel });
  const send = el('button', { type: 'submit', className: 'send', textContent: labels.send });
  const form = el('form', {}, [title, text, email, el('div', { className: 'row' }, [cancel, send])]);
  const thanks = el('p', { hidden: true, textContent: labels.thanks });
  thanks.setAttribute('role', 'status');
  const panel = el('div', { className: 'panel', hidden: true }, [form, thanks]);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'title');

  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (opened: boolean) => {
    clearTimeout(timer);
    panel.hidden = !opened;
    open.hidden = opened;
    open.setAttribute('aria-expanded', String(opened));
    form.hidden = false;
    thanks.hidden = true;
    if (opened) text.focus();
    else open.focus();
  };

  open.addEventListener('click', () => show(true));
  cancel.addEventListener('click', () => show(false));
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    show(false);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = text.value.trim();
    if (!value) return text.focus();
    bridge.send(value, email.value.trim());
    text.value = '';
    form.hidden = true;
    thanks.hidden = false;
    timer = setTimeout(() => show(false), 2500);
  });

  root.append(style, open, panel);
  (document.body ?? document.documentElement).appendChild(host);
}

try {
  const win = window as Window & { __kimmiFeedback?: Bridge & { mounted?: boolean } };
  const bridge = win.__kimmiFeedback;
  if (bridge && !bridge.mounted) {
    bridge.mounted = true;
    mount(bridge);
  }
} catch {
  // never break the page
}
