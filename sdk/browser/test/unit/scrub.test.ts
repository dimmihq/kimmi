import { describe, expect, it } from 'vitest';
import { stripCssUrls } from '../../src/dom-privacy';
import { REDACTED, scrubPayload, scrubText, scrubUrl, sensitiveKey, type ScrubOptions } from '../../src/scrub';

const on: ScrubOptions = { emails: true, phones: true };
const text = (value: string, options: ScrubOptions = on) => scrubText(value, options);
const url = (value: string, options: ScrubOptions = on) => scrubUrl(value, options);

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFkYSIsImlhdCI6MTUxNjIzOTAyMn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('sensitiveKey', () => {
  it.each([
    'password', 'Password', 'new_password', 'newPassword', 'user[password]', 'passwd', 'pwd', 'secret', 'client_secret',
    'token', 'access_token', 'accessToken', 'refresh-token', 'id_token', 'csrfToken', 'api_key', 'apiKey', 'APIKey',
    'X-API-Key', 'apikey', 'key', 'auth', 'Authorization', 'session', 'sessionId', 'sid', 'PHPSESSID', 'code', 'otp',
    'pin', 'ssn', 'card', 'cardNumber', 'card_number', 'cvc', 'cvv', 'iban', 'X-Amz-Signature', 'sig', 'Cookie',
    'verification_code', 'otp_code',
  ])('treats %s as sensitive', (key) => expect(sensitiveKey(key)).toBe(true));

  it.each([
    'email', 'name', 'note', 'q', 'page', 'sort', 'author', 'authorId', 'countryCode', 'postal_code', 'zipCode',
    'promo_code', 'statusCode', 'cardTitle', 'giftCardBalance', 'keyboard', 'monkey', 'pinned', 'spinner', 'utm_source',
    'state', 'redirect_uri', 'id', 'orderId',
  ])('keeps %s', (key) => expect(sensitiveKey(key)).toBe(false));
});

describe('scrubText: key and value pairs', () => {
  it('redacts sensitive JSON values and keeps the rest', () => {
    expect(text('{"password":"x","note":"hi"}')).toBe(`{"password":"${REDACTED}","note":"hi"}`);
    expect(text('{"apiKey": "abc", "count": 3, "pin": 1234}')).toBe(`{"apiKey": "${REDACTED}", "count": 3, "pin": ${REDACTED}}`);
    expect(text('{"user":{"refresh_token":"r\\"t"},"id":7}')).toBe(`{"user":{"refresh_token":"${REDACTED}"},"id":7}`);
  });

  it('redacts JSON that was itself put in a JSON string, and truncated JSON', () => {
    expect(text('"{\\"token\\":\\"abc\\",\\"ok\\":true}"')).toBe(`"{\\"token\\":\\"${REDACTED}\\",\\"ok\\":true}"`);
    expect(text('{"password":"hunter2-and-then-the-body-was-cut')).toBe(`{"password":"${REDACTED}`);
  });

  it('redacts form, query, cookie and log style pairs', () => {
    expect(text('password=hunter2&remember=1')).toBe(`password=${REDACTED}&remember=1`);
    expect(text('GET /cb?code=4/0AY0e&state=xyz')).toBe(`GET /cb?code=${REDACTED}&state=xyz`);
    expect(text('sid=abc123; theme=dark; csrf_token=q9')).toBe(`sid=${REDACTED}; theme=dark; csrf_token=${REDACTED}`);
    expect(text("login failed, password: 'hunter2' for ada")).toBe(`login failed, password: '${REDACTED}' for ada`);
    expect(text('otp: 123456')).toBe(`otp: ${REDACTED}`);
  });

  it('leaves ordinary pairs alone', () => {
    for (const value of ['color: red', 'at 10:30:00', 'sort=price&page=2', '{"author":"Ada","code_lines":10}', 'https://a.dev/x']) {
      expect(text(value)).toBe(value);
    }
  });
});

describe('scrubText: credentials anywhere', () => {
  it('redacts bearer and basic credentials', () => {
    expect(text('Authorization: Bearer abc.def-123')).not.toContain('abc.def-123');
    expect(text('header Bearer sk_test_51Hx')).toBe(`header Bearer ${REDACTED}`);
    expect(text('Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED}`);
    expect(text('Basic training for new staff. A bearer bond.')).toBe('Basic training for new staff. A bearer bond.');
  });

  it('redacts JWTs in messages and stacks', () => {
    expect(text(`Session expired for ${JWT} at login`)).toBe(`Session expired for ${REDACTED} at login`);
    expect(text(`token:${JWT}`)).toBe(`token:${REDACTED}`);
    expect(text(`at https://a.dev/app.js?t=${JWT}:1:2`)).not.toContain('eyJ');
    expect(text('eyJ is how base64 JSON starts')).toBe('eyJ is how base64 JSON starts');
  });

  it('redacts long random secrets and keeps ordinary ids', () => {
    const secrets = [
      // Assembled here so secret scanners do not mistake the fixture for a real key.
      `sk_${'live'}_51HxYzAbCdEfGh1234IjKlMnOpQrStUvWx5678`,
      'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
      '9dZq3Lx7Vb2Nw8Rk/Tf4Hs1Gm6Jc5Pa0Ye+QuOiX',
      'AKIAIOSFODNN7EXAMPLE',
      'd41d8cd98f00b204e9800998ecf8427e',
      '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12',
      'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    ];
    for (const secret of secrets) expect(text(`key in log ${secret} end`)).not.toContain(secret.slice(8, 24));
    const ordinary = [
      '123e4567-e89b-12d3-a456-426614174000',
      '018f3c9e-7b1a-7c3d-9e2f-1a2b3c4d5e6f',
      'ORD-2026-000123',
      'order #48213',
      '507f1f77bcf86cd799439011',
      'pi_3MtwBwLkdIwHu7ix28a3tqPa',
      'cus_NffrFeUfNV2Hib',
      'V1StGXR8_Z5jdHi6B-myT',
      '2026-11-27T10:15:30.123Z',
      '1795750000000',
      '#ff00aa and #FFF',
      'v4.18.2',
      'shop@1.4.0',
      '£1,234.50 and $19.99',
      'getElementByIdForUser2024Version',
      'node_modules/react-dom/cjs/react-dom.production.min.js',
      'http://localhost:5220/assets/index-BzX9k2Qa.js:12:34',
      '/api/v1/users/12345/orders/67890/items/abcdef/details',
      'Donaudampfschifffahrtsgesellschaftskapitän',
    ];
    for (const value of ordinary) expect(text(value)).toBe(value);
  });

  it('catches nearly every random 40 character token', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const tokens = Array.from({ length: 500 }, () =>
      Array.from(crypto.getRandomValues(new Uint8Array(40)), (byte) => alphabet[byte % 62]).join(''),
    );
    expect(tokens.filter((token) => text(token) === REDACTED).length).toBeGreaterThan(475);
  });
});

describe('scrubText: card numbers and SSNs', () => {
  it('redacts Luhn-valid cards in common layouts', () => {
    expect(text('card 4242 4242 4242 4242 ok')).toBe(`card ${REDACTED} ok`);
    expect(text('5555-5555-5555-4444')).toBe(REDACTED);
    expect(text('378282246310005')).toBe(REDACTED);
    expect(text('pay 4242424242424242 12/34 cvc')).toBe(`pay ${REDACTED} 12/34 cvc`);
    expect(text('4242424242424242 123')).toBe(`${REDACTED} 123`);
  });

  it('keeps numbers that are not cards', () => {
    for (const value of ['4242 4242 4242 4241', '1795750000000', '1795750000000123', '12345678901234', 'order 100000000000001']) {
      expect(text(value)).toBe(value);
    }
  });

  it('redacts SSNs and keeps dates and ids of the same shape', () => {
    expect(text('ssn on file 123-45-6789.')).toBe(`ssn on file ${REDACTED}.`);
    for (const value of ['2026-11-27', '000-12-3456', '123-00-4567', '666-12-3456', '1234-56-7890']) expect(text(value)).toBe(value);
  });
});

describe('scrubText: emails and phones', () => {
  it('replaces emails and keeps look-alikes', () => {
    expect(text('Signed in as ada.lovelace+shop@example.co.uk.')).toBe('Signed in as [email].');
    expect(text('{"email":"a@b.co"}')).toBe('{"email":"[email]"}');
    for (const value of ['shop@1.4.0', '@scope/pkg', 'a@b', 'name @ host']) expect(text(value)).toBe(value);
  });

  it('replaces phone numbers in common formats', () => {
    for (const phone of ['+44 20 7946 0958', '+1 (555) 123-4567', '(555) 123-4567', '555-123-4567', '555.123.4567', '020 7946 0958', '01 23 45 67 89', '+2348031234567']) {
      expect(text(`call ${phone} now`)).toBe('call [phone] now');
    }
  });

  it('keeps numbers that are not phones', () => {
    for (const value of [
      '2026-11-27 10:30', '27-11-2026 1030', 'ORD-2026-000123', '1795750000', '192.168.100.200', '10.100.200.300',
      '1 2 3 4 5 6 7 8 9 10', '£12.50 13.75 14.99', 'v10.0.19041.1', '+20.5%', 'id 1234567890',
    ]) {
      expect(text(value)).toBe(value);
    }
  });

  it('can leave emails and phones in when the project turns that off', () => {
    const off: ScrubOptions = { emails: false, phones: false };
    expect(text('ada@example.com +44 20 7946 0958', off)).toBe('ada@example.com +44 20 7946 0958');
    expect(text('ada@example.com password=x', off)).toBe(`ada@example.com password=${REDACTED}`);
  });
});

describe('scrubUrl', () => {
  it('redacts sensitive parameters and keeps the path and the rest of the query', () => {
    expect(url('https://shop.dev/reset?token=abc123&step=2')).toBe(`https://shop.dev/reset?token=${REDACTED}&step=2`);
    expect(url('/api?token=abc&email=a@b.c')).toBe(`/api?token=${REDACTED}&email=[email]`);
    expect(url('/api?email=a%40b.co&q=oak+tray')).toBe('/api?email=[email]&q=oak+tray');
    expect(url('https://app.dev/cb#access_token=abc&state=s1')).toBe(`https://app.dev/cb#access_token=${REDACTED}&state=s1`);
    expect(url('https://app.dev/#/route?api_key=k1&tab=2')).toBe(`https://app.dev/#/route?api_key=${REDACTED}&tab=2`);
    expect(url('https://ada:hunter2@host.dev/x')).toBe(`https://${REDACTED}@host.dev/x`);
    expect(url(`https://a.dev/magic/${JWT}`)).toBe(`https://a.dev/magic/${REDACTED}`);
    expect(url('https://s3.dev/b/k?X-Amz-Credential=AKIA%2F1&X-Amz-Signature=f00d&X-Amz-Expires=60')).toBe(
      `https://s3.dev/b/k?X-Amz-Credential=${REDACTED}&X-Amz-Signature=${REDACTED}&X-Amz-Expires=60`,
    );
  });

  it('leaves ordinary URLs untouched', () => {
    for (const value of ['https://shop.acme.dev/checkout', '/products/oak-tray', 'https://a.dev/s?q=oak&page=2#reviews', '', 'about:blank']) {
      expect(url(value)).toBe(value);
    }
  });
});

describe('the scrub hook', () => {
  it('runs last, on text and URLs', () => {
    const options: ScrubOptions = { ...on, custom: (value) => value.replace(/ACME-\d+/g, '[account]') };
    expect(scrubText('account ACME-991 password=x', options)).toBe(`account [account] password=${REDACTED}`);
    expect(scrubUrl('/a/ACME-12?token=t', options)).toBe(`/a/[account]?token=${REDACTED}`);
  });

  it('falls back to the built-in result when the hook throws or returns something else', () => {
    const throwing: ScrubOptions = { ...on, custom: () => { throw new Error('boom'); } };
    expect(scrubText('token=t', throwing)).toBe(`token=${REDACTED}`);
    const wrong = { ...on, custom: () => 42 } as unknown as ScrubOptions;
    expect(scrubText('ok', wrong)).toBe('ok');
  });
});

describe('scrubPayload', () => {
  it('scrubs every recorded string of each event and keeps identify as sent', () => {
    expect(scrubPayload('network', { method: 'POST', url: '/api?token=t', status: 200, ms: 3, size: 9, kind: 'fetch', requestBody: '{"password":"p"}', responseBody: 'a@b.co' }, on)).toEqual({
      method: 'POST', url: `/api?token=${REDACTED}`, status: 200, ms: 3, size: 9, kind: 'fetch', requestBody: `{"password":"${REDACTED}"}`, responseBody: '[email]',
    });
    expect(scrubPayload('error', { message: `bad ${JWT}`, source: 'https://a.dev/x.js?key=k:1:2', stack: 'at x (a@b.co)' }, on)).toEqual({
      message: `bad ${REDACTED}`, source: `https://a.dev/x.js?key=${REDACTED}`, stack: 'at x ([email])',
    });
    expect(scrubPayload('console', { level: 'log', text: '4242 4242 4242 4242', source: '' }, on).text).toBe(REDACTED);
    expect(scrubPayload('navigate', { href: 'https://a.dev/r?otp=1', path: '/r', title: 'Hi ada@x.io' }, on)).toEqual({ href: `https://a.dev/r?otp=${REDACTED}`, path: '/r', title: 'Hi [email]' });
    expect(scrubPayload('dead-click', { selector: 'button', text: 'Email ada@x.io' }, on).text).toBe('Email [email]');
    const identify = { id: 'ada@x.io', email: 'ada@x.io' };
    expect(scrubPayload('identify', identify, on)).toBe(identify);
  });
});

describe('stripCssUrls', () => {
  it('replaces image URLs and keeps fonts', () => {
    expect(stripCssUrls('.a{background:url("/bg.png") no-repeat}')).toBe('.a{background:none no-repeat}');
    expect(stripCssUrls("b{background-image:url( 'data:image/png;base64,iVBOR' )}")).toBe('b{background-image:none}');
    expect(stripCssUrls('c{mask:URL(x.svg)}')).toBe('c{mask:none}');
    const font = '@font-face{src:url("/f.woff2") format("woff2"),url(data:font/woff;base64,AAA)}';
    expect(stripCssUrls(font)).toBe(font);
    expect(stripCssUrls('d{color:red}')).toBe('d{color:red}');
  });
});

describe('linear time on adversarial input', () => {
  const size = 100_000;
  const inputs: Record<string, string> = {
    letters: 'a'.repeat(size),
    mixed: 'aB3'.repeat(size / 3),
    jwtish: 'eyJ-'.repeat(size / 4),
    dots: 'eyJa.'.repeat(size / 5),
    emailish: 'a.'.repeat(size / 2) + '@',
    ats: 'a@'.repeat(size / 2),
    domains: '@a.'.repeat(size / 3),
    digits: '4'.repeat(size),
    spacedDigits: '4 '.repeat(size / 2),
    phoneish: '1' + ' '.repeat(size),
    parens: '+('.repeat(size / 2),
    keys: '"a":'.repeat(size / 4),
    escapedKeys: '\\"token\\":\\"'.repeat(size / 12),
    openValue: '"password":"' + 'x'.repeat(size),
    pairs: 'password='.repeat(size / 9),
    colons: 'a:'.repeat(size / 2),
    bearer: 'Bearer '.repeat(size / 7),
    query: '?token=&'.repeat(size / 8),
    css: 'url(' + ' '.repeat(size),
    cssOpen: 'url("'.repeat(size / 5),
  };

  it.each(Object.keys(inputs))('scrubs 100 KB of %s quickly', (name) => {
    const input = inputs[name]!;
    const started = performance.now();
    scrubText(input, on);
    scrubUrl(input, on);
    stripCssUrls(input);
    expect(performance.now() - started).toBeLessThan(250);
  });

  // A time limit alone passes a quadratic pattern on a fast machine. Doubling
  // the input must not much more than double the time.
  it.each(Object.keys(inputs))('scales linearly on %s', (name) => {
    const once = inputs[name]!;
    const time = (input: string) => {
      const started = performance.now();
      scrubText(input, on);
      scrubUrl(input, on);
      stripCssUrls(input);
      return performance.now() - started;
    };
    const small = Math.max(time(once.repeat(2)), 1);
    const large = time(once.repeat(8));
    expect(large / small).toBeLessThan(12);
  });
});
