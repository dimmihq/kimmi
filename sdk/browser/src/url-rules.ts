import type { UrlRule } from './types';

function matchesRule(rule: UrlRule, href: string, path: string): boolean {
  const { pattern } = rule;
  switch (rule.type) {
    case 'contains':
      return href.includes(pattern);
    case 'exact':
      return href === pattern || path === pattern;
    case 'startsWith':
      return href.startsWith(pattern) || path.startsWith(pattern);
    case 'endsWith':
      return href.endsWith(pattern) || path.endsWith(pattern);
    // The dashboard's "Matches" rule is a regular expression.
    case 'matches':
    case 'regex':
      try {
        return new RegExp(pattern).test(href);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** With no rules every URL is recorded; otherwise at least one rule must match. */
export function urlAllowed(rules: UrlRule[], href: string): boolean {
  if (rules.length === 0) return true;
  let path = href;
  try {
    path = new URL(href).pathname;
  } catch {
    // keep the raw value
  }
  return rules.some((rule) => matchesRule(rule, href, path));
}
