import kimmi from '@kimmi/browser';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router';

// Fixtures for the SDK's privacy tests (sdk/browser/test/e2e/privacy.spec.ts): every string below
// that names Ada or looks like a secret must never reach a recording under the matching setting.
const LAB_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZGEtbGFiIiwicm9sZSI6ImFkbWluIn0.dGhpc0lzVGhlTGFiU2lnbmF0dXJlNDI';
// Assembled so secret scanners do not mistake the fixture for a real key.
const LAB_API_KEY = `sk_${'live'}_51LabSecretKeyAbCdEfGh1234IjKlMnOpQr`;
const SWATCH = '/lab/swatch.svg';
const DATA_IMAGE =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0IiBoZWlnaHQ9IjQiLz4=';

const blankForm = { email: '', tel: '', number: '', search: '', text: '', textarea: '', tier: '', plain: '', ignored: '', wrapped: '' };

export function PrivacyLabPage() {
  const navigate = useNavigate();
  const [note, setNote] = useState('Masked note: Ada prefers deliveries after six');
  const [extraNote, setExtraNote] = useState<string | null>(null);
  const [visibleLater, setVisibleLater] = useState(false);
  const [blockedLater, setBlockedLater] = useState(false);
  const [mediaLater, setMediaLater] = useState(false);
  const [form, setForm] = useState(blankForm);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const previous = document.title;
    document.title = 'Privacy lab for Ada Lovelace';
    const context = canvas.current?.getContext('2d');
    if (context) {
      context.fillStyle = '#a33a2b';
      context.fillRect(0, 0, 120, 60);
    }
    return () => {
      document.title = previous;
    };
  }, []);

  const field = (name: keyof typeof blankForm) => ({
    value: form[name],
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((current) => ({ ...current, [name]: event.target.value })),
  });

  const callApi = async () => {
    await fetch('/api/echo?token=LabQueryToken77&email=a@b.c', {
      method: 'POST',
      headers: { Authorization: 'Bearer LabBearerSecret99', 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'LabBodyPassword', note: 'hi' }),
    });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/echo?api_key=LabXhrKey31');
    xhr.setRequestHeader('X-API-Key', 'LabXhrHeaderKey');
    xhr.send('card_number=4000056655665556&cvc=123&plan=gold');
  };

  return (
    <section className="panel lab">
      <h1>Privacy lab</h1>
      <p className="muted">Test fixtures for kimmi's privacy settings. Nothing here is a real customer.</p>
      <div className="actions">
        <button type="button" className="button primary" data-testid="opt-in" onClick={() => kimmi.optIn()}>
          Allow recording
        </button>
        <button type="button" className="button ghost" data-testid="opt-out" onClick={() => kimmi.optOut()}>
          Do not record me
        </button>
      </div>

      <h2>Masked text</h2>
      <p data-testid="visible-text">Visible: oak trays restocked</p>
      {visibleLater && <p>Visible later: linen throws are back</p>}
      <div className="secret-note" data-testid="secret-note">
        <p data-testid="note-text">{note}</p>
        <span>
          <em>Nested secret: the blue door</em>
        </span>
        <abbr title="Title secret Ada">TS</abbr>
        <input placeholder="Placeholder secret Ada" aria-label="Aria secret Ada" readOnly />
        <img src={DATA_IMAGE} alt="Alt secret Ada" width={4} height={4} />
        <input type="submit" value="Value secret Ada" />
        {extraNote && <p className="extra">{extraNote}</p>}
      </div>
      {extraNote && <div className="secret-note">Added note: ring the bell twice</div>}
      <p data-private>Data private: Ada's shoe size is six</p>
      <p className="kimmi-mask">Class mask: Ada's birthday is in December</p>
      <button
        type="button"
        className="button"
        data-testid="change-text"
        onClick={() => {
          setNote('Updated note: leave parcels with Grace');
          setExtraNote('Extra note: Grace works nights');
          setVisibleLater(true);
        }}
      >
        Change text
      </button>

      <h2>Blocked</h2>
      <div className="blocked-panel" data-testid="blocked-panel">
        <p>Blocked: Ada's loyalty balance is 4,210 points</p>
        <img src={`${SWATCH}?in=blocked`} alt="" width={40} height={40} />
        {blockedLater && <p>Blocked later: Ada redeemed 300 points</p>}
      </div>
      <div className="kimmi-block">Kimmi block: Ada's support PIN hint</div>
      <button type="button" className="button" data-testid="change-blocked" onClick={() => setBlockedLater(true)}>
        Change blocked panel
      </button>

      <h2>Inputs</h2>
      <div className="form">
        <input type="email" data-testid="lab-email" {...field('email')} />
        <input type="tel" data-testid="lab-tel" {...field('tel')} />
        <input type="number" data-testid="lab-number" {...field('number')} />
        <input type="search" data-testid="lab-search" {...field('search')} />
        <input type="text" data-testid="lab-text" {...field('text')} />
        <textarea data-testid="lab-textarea" {...field('textarea')} />
        <select data-testid="lab-select" {...field('tier')}>
          <option value="">Choose a tier</option>
          <option value="silver">Silver tier</option>
          <option value="platinum">Platinum tier</option>
        </select>
        <div contentEditable suppressContentEditableWarning className="editable" data-testid="lab-editable">
          Edit me:{' '}
        </div>
        <input type="password" data-testid="lab-password" />
        <input type="hidden" name="csrf" value="csrf-HiddenSecret123" />
        <input type="text" data-testid="lab-plain" {...field('plain')} />
        <input type="text" className="ignored-field" data-testid="lab-ignored" {...field('ignored')} />
        <div className="kimmi-ignore">
          <input type="text" data-testid="lab-kimmi-ignore" {...field('wrapped')} />
        </div>
      </div>

      <h2>Media</h2>
      <div className="lab-media" data-testid="media">
        <img src={`${SWATCH}?in=img`} alt="" width={40} height={40} />
        <img src={DATA_IMAGE} alt="" width={40} height={40} />
        <picture>
          <source srcSet={`${SWATCH}?in=source`} media="(min-width: 1px)" />
          <img src={`${SWATCH}?in=picture`} alt="" width={40} height={40} />
        </picture>
        <video poster={`${SWATCH}?in=poster`} src={`${SWATCH}?in=video`} width={40} height={40} />
        <audio src={`${SWATCH}?in=audio`} />
        <svg width={40} height={40}>
          <image href={`${SWATCH}?in=svg`} width={40} height={40} />
        </svg>
        <canvas ref={canvas} width={120} height={60} />
        <div className="lab-tile" style={{ backgroundImage: `url(${SWATCH}?in=inline)` }} />
        <div className="lab-tile lab-css-bg" />
        <div className="lab-tile" style={mediaLater ? { backgroundImage: `url("${SWATCH}?in=later-style")` } : undefined} />
        {mediaLater && <img src={`${SWATCH}?in=later`} alt="" width={40} height={40} />}
      </div>
      <button type="button" className="button" data-testid="add-media" onClick={() => setMediaLater(true)}>
        Add media
      </button>

      <h2>Secrets outside the page</h2>
      <div className="actions">
        <button
          type="button"
          className="button"
          data-testid="log-secrets"
          onClick={() => {
            console.log('Session token', LAB_JWT, 'for ada.scrub@example.com, card 4242 4242 4242 4242');
            console.warn({ password: 'Hunter2-lab', apiKey: LAB_API_KEY, note: 'kept note' });
            console.info('Call Ada on +44 20 7946 0958, SSN 123-45-6789, account FH-204817');
          }}
        >
          Log secrets
        </button>
        <button type="button" className="button" data-testid="call-api" onClick={() => void callApi()}>
          Call the API
        </button>
        <button
          type="button"
          className="button"
          data-testid="throw-secret"
          onClick={() => {
            void Promise.reject(new Error('Card 4000 0566 5566 5556 was declined'));
            throw new Error(`Session expired for ${LAB_JWT}`);
          }}
        >
          Throw an error
        </button>
        <button
          type="button"
          className="button"
          data-testid="reset-link"
          onClick={() => navigate('/reset?token=LabResetToken123&email=ada.reset@example.com')}
        >
          Open a reset link
        </button>
        <button type="button" className="button ghost" data-testid="dead-contact">
          Contact ada.dead@example.com
        </button>
      </div>
    </section>
  );
}
