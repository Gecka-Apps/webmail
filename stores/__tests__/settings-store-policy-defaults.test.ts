import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));

import { useSettingsStore } from '../settings-store';
import { usePolicyStore } from '../policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';

describe('policy defaults', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    useSettingsStore.getState().disableSync();
    useSettingsStore.setState({ externalContentPolicy: 'ask', emailsPerPage: 50, chosenSettings: [] });
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, defaults: {} } });
  });

  it('fills settings the user never chose', () => {
    useSettingsStore.getState().applyPolicyDefaults({ externalContentPolicy: 'allow', emailsPerPage: 25 });

    expect(useSettingsStore.getState().externalContentPolicy).toBe('allow');
    expect(useSettingsStore.getState().emailsPerPage).toBe(25);
    // Applying a default is not a choice: a later default still applies.
    expect(useSettingsStore.getState().chosenSettings).toEqual([]);
  });

  it('leaves an explicit choice alone, even one equal to the built-in value', () => {
    useSettingsStore.getState().updateSetting('externalContentPolicy', 'ask');

    useSettingsStore.getState().applyPolicyDefaults({ externalContentPolicy: 'allow' });

    expect(useSettingsStore.getState().externalContentPolicy).toBe('ask');
    expect(useSettingsStore.getState().chosenSettings).toContain('externalContentPolicy');
  });

  it('ignores unknown keys and empty values', () => {
    useSettingsStore.getState().applyPolicyDefaults({ notASetting: 1, externalContentPolicy: null, chosenSettings: ['x'] });

    expect(useSettingsStore.getState().externalContentPolicy).toBe('ask');
    expect(useSettingsStore.getState().chosenSettings).toEqual([]);
    expect('notASetting' in useSettingsStore.getState()).toBe(false);
  });

  it('re-applies the defaults over a synced blob that carries built-in values', () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, defaults: { externalContentPolicy: 'allow' } } });

    // Another device never touched the setting: its blob says 'ask' and
    // lists no choice for it.
    useSettingsStore.getState().importSettings(JSON.stringify({ externalContentPolicy: 'ask', chosenSettings: [] }));
    expect(useSettingsStore.getState().externalContentPolicy).toBe('allow');

    // That device did choose: the choice travels with the blob and wins.
    useSettingsStore.getState().importSettings(
      JSON.stringify({ externalContentPolicy: 'block', chosenSettings: ['externalContentPolicy'] }),
    );
    expect(useSettingsStore.getState().externalContentPolicy).toBe('block');
  });

  it('exports the choices so they follow the user across devices', () => {
    useSettingsStore.getState().updateSetting('emailsPerPage', 100);

    const exported = JSON.parse(useSettingsStore.getState().exportSettings());
    expect(exported.chosenSettings).toEqual(['emailsPerPage']);
  });
});
