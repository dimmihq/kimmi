# @kimmi/browser

The browser SDK for kimmi, self-hosted session replay. It records the page with rrweb, adds console, network, error and frustration-click events, and sends everything to your kimmi server. It also sends page views, clicks, custom events and web vitals for the project's analytics.

```sh
npm install @kimmi/browser
```

```ts
import kimmi from '@kimmi/browser';

kimmi.init({ key: 'km_pub_...', host: 'https://kimmi.example.com', release: 'web@1.4.0' });
kimmi.identify('user-42', { email: 'ada@example.com', name: 'Ada' });
kimmi.track('plan_selected', { plan: 'pro', value: 49 });
```

Or with no build step:

```html
<script src="https://kimmi.example.com/kimmi.js" data-key="km_pub_..." defer></script>
```

## API

| Call | What it does |
|---|---|
| `init({ key, host, release?, scrub? })` | Starts recording. A second call does nothing. |
| `identify(id, traits?)` | Attaches a user to this visitor and later sessions. Sent as given, never scrubbed. |
| `optIn()` / `optOut()` | Records consent in `localStorage`. `optOut()` stops recording and analytics at once and drops anything not yet sent. |
| `stop()` | Sends what is buffered and stops on this page. |
| `getSessionId()` | The session being recorded, or `null`. |
| `track(name, props?)` | Sends a custom event. See [Analytics](#analytics). |
| `feedback(text, { email? })` | Sends a visitor's feedback to the dashboard. |
| `showFeedback(position?)` | Shows the feedback button, `'bottom-right'` (default) or `'bottom-left'`. |

No call throws, and all of them do nothing on the server.

## Analytics

When the project has analytics on, the SDK sends small JSON "hits" to `/i/v1/hit`, every 2 seconds while there is something to send and once more when the page is hidden. Hits do not depend on a recording: they flow when the session is sampled out, shorter than the minimum duration, or outside the URL rules.

A hit carries the visit id, the visitor's anonymous id, the page URL, the landing page and referrer of the visit, the viewport, language, time zone and release, and up to 100 events:

| Event | When | What it holds |
|---|---|---|
| `page` | On load and on every client-side navigation. | Path and title. |
| `leave` | When the page is left or hidden. | Engaged time (visible, and within 60 s of the last scroll, click, key press, mouse move or touch), deepest scroll in percent, document height, viewport width. |
| `click` | Every click, if the project has heatmaps on. | A short CSS path, up to 40 characters of the element's text, and the position in the document. |
| `track` | `kimmi.track()` and the automatic events below. | Name, props, value. |
| `error` | Uncaught errors and unhandled rejections. | Message, source, and the first 2000 characters of the stack. |
| `rage`, `dead` | Rage and dead clicks, while recording. | CSS path and text. |
| `request` | A request that failed, answered 400 or above, or took 3 s or more. | Method, host and path (never the query), status, duration. |
| `vital` | Once per page load, when the page is first hidden. | LCP, CLS, INP, FCP and TTFB, where the browser measures them. Off with the project's performance setting. |

While a recording runs, the visit is the recording session. Without one, the visit is kept in `sessionStorage` and ends after 30 minutes without activity.

### Custom events

```ts
kimmi.track('plan_selected', { plan: 'pro', value: 49 });
```

The name is cut to 64 characters. Props must be a plain object that JSON can hold. `value`, or else `revenue`, is the number the dashboard adds up. Strings in props are scrubbed like everything else, a prop named like a secret (`token`, `password`, `key`…) is redacted, and props over 1024 characters of JSON are dropped while the event is still sent. Calls made before the SDK has its settings are kept, up to 50. While a recording runs, the event is added to it too.

### Automatic events

If the project has automatic events on, these are sent as `track` events:

| Name | When | Props |
|---|---|---|
| `$outbound` | A click on a link to another host. | `url`: host and path. |
| `$download` | A click on a link to a file: pdf, zip, csv, xlsx, xls, docx, doc, pptx, ppt, dmg, exe, mp3, mp4, gz, tar, rar, 7z, apk, pkg, txt, svg. | `file`: the file name. |
| `$email` | A click on a `mailto:` link. | None. The address is not sent. |
| `$phone` | A click on a `tel:` link. | None. The number is not sent. |
| `$form` | A form is submitted. | `form`: its id or name. `action`: the path it posts to. Field values are never sent. |

### Cookieless mode

A project can turn on cookieless analytics. Then the SDK writes nothing to `localStorage` or `sessionStorage`: the visit id lives in memory for one page load, hits carry no anonymous id, and the server ties page loads together with a hash that changes daily. `identify()` is kept in memory only. Hits are sent without asking, since nothing is stored; `optOut()` still stops them.

A recording needs storage, so in cookieless mode it starts only after `optIn()`, as with `requireConsent`. From then on the SDK stores what it normally does.

### Feedback

```ts
kimmi.feedback('The export button does nothing', { email: 'ada@example.com' });
kimmi.showFeedback();
```

`feedback()` sends up to 2000 characters, scrubbed, and the email as given. `showFeedback()` adds a small "Feedback" button to the bottom right of the page, or the bottom left with `showFeedback('bottom-left')`. A project can also show it without code, from its Analytics settings, where it is hidden by default. Its code is a separate file, `kimmi-feedback.js`, loaded from your kimmi server on first use, so it costs nothing until then. A project can also turn the button on from the dashboard. Both need analytics to be on.

## Privacy

Most privacy settings live on the project, in the dashboard, so you can change them without a deploy. Markup and the `scrub` hook cover what only your code knows.

### Mark up your page

These work with no settings at all:

| Markup | Effect |
|---|---|
| `data-private` or `class="kimmi-mask"` | Text inside is replaced with `*`, including `title`, `placeholder`, `aria-label`, `alt` and `value` attributes, and input values. |
| `class="kimmi-block"` or `data-kimmi-block` | The element and everything in it are not recorded. Playback shows an empty box of the same size. |
| `class="kimmi-ignore"` | Typing in the input, or in any input inside the element, is not recorded. |

Some fields are always masked, whatever the settings: `type="password"` (also after a "show password" toggle), `type="hidden"`, and inputs with `autocomplete` set to a `cc-*` value, `one-time-code` or a password value.

### Project settings

| Setting | Effect |
|---|---|
| `maskAllInputs` (on by default) | Every input, textarea, select and `contenteditable` region is masked. A select's value is always `***`, so its length does not give the choice away. |
| `maskAllText` | All page text is masked, including text attributes, input values and the page title. |
| `maskSelectors` | Like `data-private`, for CSS selectors. Covers nested elements and text that changes later. |
| `blockSelectors` | Like `kimmi-block`, for CSS selectors. |
| `ignoreSelectors` | Like `kimmi-ignore`, for CSS selectors. |
| `blockMedia` | Images, `<picture>`, video, audio, SVG `<image>`, canvas, `<object>`, `<embed>` and CSS image URLs are not recorded, so playback fetches nothing. Fonts stay. |
| `requireConsent` | Nothing is recorded or sent until `optIn()`. |
| `respectDnt` | Nothing is recorded or sent when the browser sends Do Not Track. |
| `scrubEmails`, `scrubPhones` (on by default) | See below. |

### Scrubbing outside the page

kimmi stores what the SDK sends without reading it, so personal data is removed in the browser, before anything leaves. This applies to console output, network URLs and bodies, errors and stacks, navigations, rage and dead click text, the URL and referrer of every batch, and everything in an analytics hit: URLs, paths, titles, click text, `track` names and props, and feedback text. The page itself is protected by masking, not scrubbing.

Always on:

- Request and response headers are never recorded, so `Authorization`, `Cookie` and API key headers cannot leak.
- Values of query, fragment, form and JSON keys that name a secret become `[redacted]`: password, secret, token (`access_token`, `csrfToken`…), key (`api_key`, `X-API-Key`…), auth, authorization, cookie, session, sid, signature, sig, credential, otp, pin, ssn, cvc, cvv, iban, card number, and a bare `code` or `card`. Matching ignores case, `-`, `_` and camelCase.
- In any text: JWTs, `Bearer` and `Basic` credentials, card numbers (13 to 19 digits that pass the Luhn check), US social security numbers, AWS key ids, and random-looking runs of 32 or more letters and digits or hex. UUIDs, order numbers, timestamps, prices, versions and colours stay.
- Credentials in URLs (`https://user:pass@host`).

On by default, off with `scrubEmails` and `scrubPhones`: email addresses become `[email]` and phone numbers `[phone]`.

Add your own rules with `scrub`. It runs last, on every string above, and must return a string:

```ts
kimmi.init({
  key: 'km_pub_...',
  host: 'https://kimmi.example.com',
  scrub: (text) => text.replace(/\bACCT-\d{8}\b/g, '[account]'),
});
```

Request and response bodies are only recorded when the project turns on network bodies, and are cut to 10 KB first.
