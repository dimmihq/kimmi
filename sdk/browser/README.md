# @kimmi/browser

The browser SDK for kimmi, self-hosted session replay. It records the page with rrweb, adds console, network, error and frustration-click events, and sends everything to your kimmi server.

```sh
npm install @kimmi/browser
```

```ts
import kimmi from '@kimmi/browser';

kimmi.init({ key: 'km_pub_...', host: 'https://kimmi.example.com', release: 'web@1.4.0' });
kimmi.identify('user-42', { email: 'ada@example.com', name: 'Ada' });
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
| `optIn()` / `optOut()` | Records consent in `localStorage`. `optOut()` stops at once and drops anything not yet sent. |
| `stop()` | Sends what is buffered and stops on this page. |
| `getSessionId()` | The session being recorded, or `null`. |

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
| `respectDnt` | Nothing is recorded when the browser sends Do Not Track. |
| `scrubEmails`, `scrubPhones` (on by default) | See below. |

### Scrubbing outside the page

kimmi stores what the SDK sends without reading it, so personal data is removed in the browser, before anything leaves. This applies to console output, network URLs and bodies, errors and stacks, navigations, rage and dead click text, and the URL and referrer of every batch. The page itself is protected by masking, not scrubbing.

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
