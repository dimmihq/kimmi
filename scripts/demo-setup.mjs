// Sets up the demo's projects through the dashboard API, the way a person would in the settings pages.
//   node scripts/demo-setup.mjs before   settings, goals, funnels, the webhook
//   node scripts/demo-setup.mjs after    notes, stars, public links, saved views, a digest
// Reads DEV_ACCOUNT_EMAIL and DEV_ACCOUNT_PASSWORD from the environment (the repository's .env).
const KIMMI = process.env.KIMMI_URL ?? 'http://localhost:8700';
export const KEYS = { rich: `km_pub_${'de30'.repeat(4)}`, replay: `km_pub_${'de31'.repeat(4)}` };
const HOOK = process.env.DEMO_HOOK ?? 'http://host.docker.internal:5290/hook';

let cookie = '';
async function call(method, path, body) {
  const response = await fetch(`${KIMMI}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

const phase = process.argv[2];
await call('POST', '/auth/login', { email: process.env.DEV_ACCOUNT_EMAIL, password: process.env.DEV_ACCOUNT_PASSWORD });
let projects = await call('GET', '/projects');
const rich = projects.find((project) => project.publicKey === KEYS.rich);
const replay = projects.find((project) => project.publicKey === KEYS.replay);
if (!rich || !replay) throw new Error('create the demo projects first (make demo does)');

if (phase === 'before') {
  await call('PATCH', `/projects/${rich.id}`, { timezone: 'Europe/London' });
  await call('PATCH', `/projects/${replay.id}`, { timezone: 'Europe/London' });
  await call('PATCH', `/projects/${rich.id}/settings`, {
    retention: { days: 90 },
    analytics: {
      enabled: true,
      retentionDays: 365,
      goals: [
        { id: '', name: 'Purchase', kind: 'event', value: 'purchase' },
        { id: '', name: 'Added to cart', kind: 'event', value: 'add_to_cart' },
        { id: '', name: 'Reached checkout', kind: 'page', value: '/checkout' },
        { id: '', name: 'Signed in', kind: 'page', value: '/login' },
      ],
      funnels: [
        {
          id: '',
          name: 'Buy something',
          steps: [
            { kind: 'page', value: '/' },
            { kind: 'page', value: '/products/*' },
            { kind: 'event', value: 'add_to_cart' },
            { kind: 'page', value: '/cart' },
            { kind: 'page', value: '/checkout' },
            { kind: 'event', value: 'purchase' },
          ],
        },
        {
          id: '',
          name: 'Product page to cart',
          steps: [
            { kind: 'page', value: '/products/*' },
            { kind: 'event', value: 'add_to_cart' },
            { kind: 'page', value: '/cart' },
          ],
        },
      ],
    },
    feedback: { button: 'bottom-left' },
    sharing: { enabled: true },
    alerts: { webhookUrl: HOOK, secret: 'demo-signing-secret', newErrors: true, errorSpike: 400, rageSpike: 400, noTraffic: true, feedback: true, weeklyDigest: true },
  });
  await call('PATCH', `/projects/${replay.id}/settings`, { retention: { days: 90 }, sharing: { enabled: true } });
  if (!projects.some((project) => project.name === 'New landing page')) {
    await call('POST', '/projects', { name: 'New landing page', origin: 'https://launch.fernhill.example', platform: 'astro' });
  }
  console.log('projects are set up');
}

if (phase === 'after') {
  const base = `/projects/${rich.id}`;
  const notes = [
    'Rage clicks on Compare right before leaving. The button does nothing.',
    'Stock check fails here and they give up.',
    'Card refused once, then it works. The message is easy to miss.',
    'Good example of someone reading the whole home page first.',
    'This is the gift card error from the footer link.',
    'Phone layout: the cart link is hard to hit.',
  ];
  const watch = (await call('GET', `${base}/recordings?sort=score&limit=40`)).items;
  for (const [index, recording] of watch.slice(0, 12).entries()) {
    if (index < notes.length) {
      await call('POST', `${base}/recordings/${recording.id}/notes`, { atMs: Math.round(Math.min(recording.durationMs, 60_000) * (0.3 + 0.1 * index)), body: notes[index] });
    }
    if (index % 2 === 0) await call('PATCH', `${base}/recordings/${recording.id}`, { starred: true });
  }
  const shares = await call('GET', `${base}/shares`);
  const links = [];
  if (!shares.some((share) => share.kind === 'recording')) {
    links.push((await call('POST', `${base}/shares`, { kind: 'recording', recordingId: watch[0].id, startMs: 2000, expiresInDays: 30 })).link);
  }
  if (!shares.some((share) => share.kind === 'dashboard')) {
    links.push((await call('POST', `${base}/shares`, { kind: 'dashboard', expiresInDays: 30 })).link);
  }
  const preferences = await call('GET', '/me/preferences');
  await call('PUT', '/me/preferences', {
    ...preferences,
    savedViews: {
      ...preferences.savedViews,
      [rich.id]: [
        { name: 'Buyers', query: 'event=track%3Apurchase' },
        { name: 'Errors at checkout', query: 'errors=1&path=%2Fcheckout' },
        { name: 'Rage clicks on phones', query: 'rage=1&device=Mobile' },
        { name: 'From the newsletter', query: 'utmSource=newsletter&sort=score' },
      ],
    },
  });
  const feedback = (await call('GET', `${base}/feedback?limit=50`)).items;
  for (const item of feedback.slice(8)) await call('PATCH', `${base}/feedback/${item.id}`, { seen: true });
  await call('POST', `${base}/alerts/digest`);
  const replayWatch = (await call('GET', `/projects/${replay.id}/recordings?sort=score&limit=6`)).items;
  for (const recording of replayWatch.slice(0, 3)) await call('PATCH', `/projects/${replay.id}/recordings/${recording.id}`, { starred: true });
  console.log('notes, stars, saved views and a digest are in place');
  for (const link of links) console.log(`public link: ${link}`);
}
