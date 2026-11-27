import { record } from 'rrweb';
import type { RecordedEvent } from './types';

// rrweb event, source and node type numbers.
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const SOURCE_MUTATION = 0;
const CSS_SOURCES = new Set([8, 13, 15]); // StyleSheetRule, StyleDeclaration, AdoptedStyleSheet
const ELEMENT = 2;
const TEXT = 3;

/** Attributes whose text a visitor reads: masked like text inside masked regions. rrweb masks only text nodes. */
const TEXT_ATTRIBUTES = [
  'title', 'placeholder', 'aria-label', 'aria-description', 'aria-valuetext', 'aria-placeholder', 'alt', 'value', 'label',
];

export interface DomPrivacy {
  /** Selector of regions whose text is masked. */
  mask: string;
  /** Replaces CSS image URLs (`url(...)`, fonts excepted) so playback fetches no media. */
  stripImages: boolean;
}

interface SerializedNode {
  type: number;
  id: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
  textContent?: string;
}

interface MutationData {
  source: number;
  adds?: Array<{ parentId: number; node: SerializedNode }>;
  attributes?: Array<{ id: number; attributes: Record<string, unknown> }>;
  texts?: Array<{ id: number; value: string | null }>;
}

const FONT_URL = /^['"]?(?:data:(?:font|application\/(?:x-)?font)|[^?#'"]*\.(?:woff2?|ttf|otf|eot)(?:[?#'"]|$))/i;
const CSS_URL = /url\(/gi;

/** `url(...)` pointing at anything but a font becomes `none`. A scan, not a regex, so it stays linear. */
export function stripCssUrls(css: string): string {
  if (!/url\(/i.test(css)) return css;
  let out = '';
  let last = 0;
  CSS_URL.lastIndex = 0;
  for (let match = CSS_URL.exec(css); match; match = CSS_URL.exec(css)) {
    const open = CSS_URL.lastIndex;
    let at = open;
    while (at < css.length && /\s/.test(css[at]!)) at++;
    const quote = css[at] === '"' || css[at] === "'" ? css[at]! : '';
    const closeQuote = quote ? css.indexOf(quote, at + 1) : at;
    const end = closeQuote < 0 ? -1 : css.indexOf(')', closeQuote);
    if (end < 0) break;
    if (!FONT_URL.test(css.slice(open, end).trim())) {
      out += `${css.slice(last, match.index)}none`;
      last = end + 1;
    }
    CSS_URL.lastIndex = end + 1;
  }
  return out + css.slice(last);
}

function stripDeep(value: unknown): unknown {
  if (typeof value === 'string') return stripCssUrls(value);
  if (Array.isArray(value)) return value.map(stripDeep);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) object[key] = stripDeep(object[key]);
  }
  return value;
}

function domNode(id: number): Node | null {
  try {
    return record.mirror.getNode(id);
  } catch {
    return null;
  }
}

function inMask(node: Node | null, selector: string, closest: boolean): boolean | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  if (!el) return null;
  try {
    return closest ? el.closest(selector) !== null : el.matches(selector);
  } catch {
    return true;
  }
}

function cleanAttributes(attributes: Record<string, unknown>, masked: boolean, privacy: DomPrivacy): void {
  if (masked) {
    for (const name of TEXT_ATTRIBUTES) {
      const value = attributes[name];
      if (typeof value === 'string') attributes[name] = value.replace(/\S/g, '*');
    }
  }
  if (privacy.stripImages) {
    for (const name of ['style', '_cssText']) {
      if (attributes[name] !== undefined) attributes[name] = stripDeep(attributes[name]);
    }
  }
}

/** Walks a serialized tree top down: a node is masked when it or an ancestor matches the selector. */
function walk(node: SerializedNode, parentTag: string, masked: boolean, privacy: DomPrivacy): void {
  if (node.type === TEXT) {
    if (privacy.stripImages && parentTag === 'style' && node.textContent) node.textContent = stripCssUrls(node.textContent);
    return;
  }
  if (node.type === ELEMENT) {
    masked = masked || inMask(domNode(node.id), privacy.mask, false) === true;
    if (node.attributes) cleanAttributes(node.attributes, masked, privacy);
  }
  for (const child of node.childNodes ?? []) walk(child, node.tagName ?? '', masked, privacy);
}

/** Applies the privacy rules rrweb has no option for, in place, before the event is buffered. */
export function sanitizeDomEvent(event: RecordedEvent, privacy: DomPrivacy): void {
  if (event.type === FULL_SNAPSHOT) {
    walk((event.data as { node: SerializedNode }).node, '', false, privacy);
    return;
  }
  if (event.type !== INCREMENTAL) return;
  const data = event.data as MutationData;
  if (data.source === SOURCE_MUTATION) {
    for (const add of data.adds ?? []) {
      const parent = domNode(add.parentId);
      walk(add.node, parent?.nodeName.toLowerCase() ?? '', inMask(parent, privacy.mask, true) === true, privacy);
    }
    for (const change of data.attributes ?? []) {
      cleanAttributes(change.attributes, inMask(domNode(change.id), privacy.mask, true) === true, privacy);
    }
    if (privacy.stripImages) {
      for (const text of data.texts ?? []) {
        if (text.value && domNode(text.id)?.parentNode?.nodeName === 'STYLE') text.value = stripCssUrls(text.value);
      }
    }
  } else if (privacy.stripImages && CSS_SOURCES.has(data.source)) {
    stripDeep(data);
  }
}
