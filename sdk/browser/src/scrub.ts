import type { CustomEventPayloads, CustomTag } from './types';

/**
 * Removes credentials and personal data from everything the SDK records outside the DOM: console
 * output, network URLs and bodies, errors, navigations and frustration-click text. The server stores
 * the compressed batch untouched, so this is the only place it can happen.
 *
 * Every pattern is linear: each regex either matches a bounded length or consumes a whole run of
 * characters so no position is scanned twice, and the checks that need more care run in callbacks.
 */

export interface ScrubOptions {
  emails: boolean;
  phones: boolean;
  /** The site owner's own pass, run after the built-in rules. */
  custom?: ((text: string) => string) | undefined;
}

export const REDACTED = '[redacted]';

const KEY_WORDS = new Set([
  'auth', 'authorization', 'cookie', 'credential', 'credentials', 'cvc', 'cvv', 'iban', 'jwt', 'key', 'otp',
  'passwd', 'password', 'pin', 'pwd', 'secret', 'session', 'sid', 'sig', 'signature', 'ssn', 'token',
]);
// Common enough as part of ordinary names (countryCode, cardTitle) that only the bare key counts.
const WHOLE_KEYS = new Set(['code', 'card']);
const KEY_PARTS =
  /password|passwd|passphrase|secret|token|apikey|accesskey|privatekey|credential|authorization|cardnumber|creditcard|ccnumber|sessionid|sessid|verificationcode|resetcode|mfacode|smscode/;

/** Whether a query, form or JSON key names a value that must not be recorded. */
export function sensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const joined = words.join('');
  return WHOLE_KEYS.has(joined) || KEY_PARTS.test(joined) || words.some((word) => KEY_WORDS.has(word));
}

// `"key": ` (also escaped, inside a JSON string) or `key=` / `key: `.
const KEY_VALUE = /\\?"([^"\\\n]{1,64})\\?"\s*:\s*|([\w.\-[\]]{1,64})(?:=|: ?)/g;
const FORM_VALUE_END = /[\s&"'<>;#]/;
const JSON_VALUE_END = /[\s,}\]]/;

/** Start and end of the value that follows a key at `at`; an object or array is left to its own keys. */
function valueSpan(text: string, at: number, json: boolean): [number, number] {
  let end = at;
  if (text.startsWith('\\"', at)) {
    const close = text.indexOf('\\"', at + 2);
    return [at + 2, close < 0 ? text.length : close];
  }
  const quote = text[at];
  if (quote === '"' || quote === "'") {
    end = at + 1;
    while (end < text.length && text[end] !== quote) end += text[end] === '\\' ? 2 : 1;
    return [at + 1, Math.min(end, text.length)];
  }
  if (json && (quote === '{' || quote === '[')) return [at, at];
  const stop = json ? JSON_VALUE_END : FORM_VALUE_END;
  while (end < text.length && !stop.test(text[end]!)) end++;
  return [at, end];
}

function redactPairs(text: string): string {
  if (!/[=:]/.test(text)) return text;
  let out = '';
  let last = 0;
  KEY_VALUE.lastIndex = 0;
  for (let match = KEY_VALUE.exec(text); match; match = KEY_VALUE.exec(text)) {
    const json = match[1] !== undefined;
    if (!sensitiveKey(json ? match[1]! : match[2]!)) continue;
    const [start, end] = valueSpan(text, KEY_VALUE.lastIndex, json);
    if (end <= start) continue;
    out += text.slice(last, start) + REDACTED;
    last = end;
    KEY_VALUE.lastIndex = end;
  }
  return out + text.slice(last);
}

const AUTH_SCHEME = /\b([Bb]earer|Basic)(\s+)([\w~+/.=-]+)/g;

function redactAuthSchemes(text: string): string {
  // A plain word after "Basic" is English, not a credential.
  return text.replace(AUTH_SCHEME, (all, scheme: string, space: string, credential: string) =>
    /^[A-Za-z][a-z]*\.?$/.test(credential) ? all : `${scheme}${space}${REDACTED}`,
  );
}

const DOTTED_RUN = /[\w-]+(?:\.[\w-]+)*/g;

function redactJwts(text: string): string {
  if (!text.includes('eyJ')) return text;
  return text.replace(DOTTED_RUN, (run) => {
    if (!run.includes('eyJ')) return run;
    const parts = run.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const at = parts[i]!.indexOf('eyJ');
      if (at < 0 || !parts[i + 1]!.startsWith('eyJ')) continue;
      parts.splice(i, 3, parts[i]!.slice(0, at) + REDACTED);
    }
    return parts.join('.');
  });
}

// Always matches a whole run of local-part characters, so a long run without `@` is scanned once.
const EMAIL_RUN = /[\w.%+-]+(?:@[\w-]+(?:\.[\w-]+)*)?/g;
const EMAIL = /^[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]+$/;

function redactEmails(text: string): string {
  if (!text.includes('@')) return text;
  return text.replace(EMAIL_RUN, (run) => (EMAIL.test(run) ? '[email]' : run));
}

const CARD_RUN = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Card networks start with 2 to 6; that keeps millisecond timestamps (they start with 1) out. */
function isCard(digits: string): boolean {
  return digits.length >= 13 && digits.length <= 19 && digits[0]! >= '2' && digits[0]! <= '6' && luhn(digits);
}

/** The run may hold more than one number ("4242… 12/34" reads as "4242… 12"): try every span of whole groups. */
function redactCardRun(run: string): string {
  // Digit groups at even indexes, their separators at odd ones.
  const parts = run.split(/([ -])/);
  const groups = (parts.length + 1) / 2;
  for (let from = 0; from < groups; from++) {
    for (let to = groups; to > from; to--) {
      const span = parts.slice(2 * from, 2 * to - 1);
      if (!isCard(span.filter((_, i) => i % 2 === 0).join(''))) continue;
      return parts.slice(0, 2 * from).join('') + REDACTED + parts.slice(2 * to - 1).join('');
    }
  }
  return run;
}

function redactCards(text: string): string {
  return text.replace(CARD_RUN, redactCardRun);
}

const SSN = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

const PHONE_RUN = /\+?\(?\d[\d ().-]*\d/g;
const DATE_LIKE = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/;
const DECIMAL = /\d\.\d{1,2}(?!\d)/;

function isPhone(run: string): boolean {
  if (DATE_LIKE.test(run) || DECIMAL.test(run)) return false;
  const groups = run.split(/\D+/).filter(Boolean);
  const digits = groups.join('').length;
  if (run[0] === '+') return digits >= 8 && digits <= 15;
  if (digits < 10 || digits > 11 || groups.length < 2) return false;
  // National formats: "(555) 123-4567", "020 7946 0958", "01 23 45 67 89", "555-123-4567".
  return run[0] === '(' || groups[0]![0] === '0' || (groups.length >= 3 && groups[groups.length - 1]!.length >= 4);
}

function redactPhones(text: string): string {
  return text.replace(PHONE_RUN, (run) => (isPhone(run) ? '[phone]' : run));
}

const SECRET_RUN = /[A-Za-z0-9+/_]+/g;
const AWS_KEY_ID = /(?:AKIA|ASIA)[0-9A-Z]{16}/;
const MIN_SECRET = 32;

function charClass(code: number): number {
  if (code >= 48 && code <= 57) return 1;
  if (code >= 97 && code <= 122) return 2;
  if (code >= 65 && code <= 90) return 3;
  return 0;
}

/**
 * Long random-looking runs: 32+ hex digits in one case, or 32+ letters and digits that switch between
 * lower case, upper case and digits on at least a quarter of the characters. Words, camelCase names,
 * paths, UUIDs (split on their dashes), Mongo ids (24) and Stripe-style ids stay.
 */
function isSecret(run: string): boolean {
  if (AWS_KEY_ID.test(run)) return true;
  if (/^(?:[0-9a-f]{32,}|[0-9A-F]{32,})$/.test(run)) return /\d/.test(run) && /[a-f]/i.test(run);
  let alnum = 0;
  let switches = 0;
  let previous = 0;
  let classes = 0;
  for (let i = 0; i < run.length; i++) {
    const kind = charClass(run.charCodeAt(i));
    if (!kind) continue;
    alnum++;
    classes |= 1 << kind;
    // Upper to lower case is how a camelCase word starts, not randomness.
    if (previous && kind !== previous && !(previous === 3 && kind === 2)) switches++;
    previous = kind;
  }
  const distinct = ((classes >> 1) & 1) + ((classes >> 2) & 1) + ((classes >> 3) & 1);
  return alnum >= MIN_SECRET && distinct >= 2 && switches * 4 >= alnum;
}

function redactSecrets(text: string): string {
  return text.replace(SECRET_RUN, (run) => (run.length >= 20 && isSecret(run) ? REDACTED : run));
}

function freeText(text: string, options: ScrubOptions, pairs = true): string {
  let out = redactAuthSchemes(text);
  if (pairs) out = redactPairs(out);
  out = redactJwts(out);
  if (options.emails) out = redactEmails(out);
  out = redactCards(out).replace(SSN, REDACTED);
  if (options.phones) out = redactPhones(out);
  return redactSecrets(out);
}

function finish(builtIn: () => string, options: ScrubOptions): string {
  let text: string;
  try {
    text = builtIn();
  } catch {
    return REDACTED;
  }
  if (!options.custom) return text;
  try {
    const custom = options.custom(text);
    return typeof custom === 'string' ? custom : text;
  } catch {
    return text;
  }
}

/** Scrubs free text: console output, error messages and stacks, request and response bodies. */
export function scrubText(text: string, options: ScrubOptions): string {
  return finish(() => freeText(text, options), options);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function scrubParams(query: string, options: ScrubOptions): string {
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return freeText(pair, options, false);
      const key = pair.slice(0, eq);
      if (sensitiveKey(decode(key))) return `${key}=${REDACTED}`;
      const value = decode(pair.slice(eq + 1));
      const clean = freeText(value, options);
      return clean === value ? pair : `${key}=${encodeURIComponent(clean).replace(/%5B/g, '[').replace(/%5D/g, ']')}`;
    })
    .join('&');
}

const USERINFO = /^([a-z][\w+.-]*:\/\/)[^/?#@]*@/i;

/** Scrubs a URL or path: credentials in it, sensitive query and fragment parameters, secrets in the path. */
export function scrubUrl(url: string, options: ScrubOptions): string {
  return finish(() => {
    let rest = url.replace(USERINFO, `$1${REDACTED}@`);
    let tail = '';
    const hashAt = rest.indexOf('#');
    if (hashAt >= 0) {
      tail = `#${scrubParams(rest.slice(hashAt + 1), options)}`;
      rest = rest.slice(0, hashAt);
    }
    const queryAt = rest.indexOf('?');
    if (queryAt >= 0) {
      tail = `?${scrubParams(rest.slice(queryAt + 1), options)}${tail}`;
      rest = rest.slice(0, queryAt);
    }
    return freeText(rest, options, false) + tail;
  }, options);
}

const URL_FIELDS = new Set(['href', 'path', 'url', 'source']);

/** A custom event payload with every string field scrubbed. `identify` is sent on purpose and kept. */
export function scrubPayload<T extends CustomTag>(tag: T, payload: CustomEventPayloads[T], options: ScrubOptions): CustomEventPayloads[T] {
  if (tag === 'identify') return payload;
  const out: Record<string, unknown> = { ...payload };
  for (const [field, value] of Object.entries(out)) {
    if (typeof value === 'string') out[field] = URL_FIELDS.has(field) ? scrubUrl(value, options) : scrubText(value, options);
  }
  return out as CustomEventPayloads[T];
}
