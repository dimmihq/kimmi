import { describe, expect, it } from 'vitest';
import { PROJECT_PAGES, PROJECT_SETTINGS, projectGroups, visiblePages } from './nav';

const keys = (pages: { key: string }[]) => pages.map((page) => page.key);
const REPLAY = ['recordings', 'live', 'visitors'];

describe('project navigation', () => {
  it('shows only the replay pages while analytics is off', () => {
    expect(keys(visiblePages(PROJECT_PAGES, false))).toEqual(REPLAY);
    const groups = projectGroups(false);
    expect(groups.map((group) => group.label)).toEqual(['Replay']);
    expect(keys(groups[0].pages)).toEqual(REPLAY);
  });

  it('treats a project that is still loading as off', () => {
    expect(keys(visiblePages(PROJECT_PAGES, undefined))).toEqual(REPLAY);
    expect(projectGroups(undefined).map((group) => group.label)).toEqual(['Replay']);
  });

  it('shows every page in three groups once analytics is on', () => {
    expect(visiblePages(PROJECT_PAGES, true)).toEqual(PROJECT_PAGES);
    const groups = projectGroups(true);
    expect(groups.map((group) => group.label)).toEqual(['Replay', 'Analytics', 'Quality']);
    expect(keys(groups[1].pages)).toEqual(['analytics', 'funnels', 'heatmaps']);
    expect(keys(groups[2].pages)).toEqual(['errors', 'friction', 'performance', 'feedback']);
    expect(groups.flatMap((group) => group.pages)).toHaveLength(PROJECT_PAGES.length);
  });

  it('hides only Alerts from the settings while analytics is off', () => {
    const off = keys(visiblePages(PROJECT_SETTINGS, false));
    expect(off).not.toContain('alerts');
    expect(off).toContain('analytics-settings');
    expect(off).toContain('sharing');
    expect(off).toHaveLength(PROJECT_SETTINGS.length - 1);
    expect(visiblePages(PROJECT_SETTINGS, true)).toEqual(PROJECT_SETTINGS);
  });
});
