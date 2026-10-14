import { describe, expect, it } from 'vitest';
import { confirmPluginEnablement, projectPluginTally } from './plugin-state';

describe('confirmPluginEnablement', () => {
  it('applies the submitted value without mutating metadata or independent plugins', () => {
    const alpha = { id: 'alpha', enabled: false, name: 'Alpha' };
    const beta = { id: 'beta', enabled: true, name: 'Beta' };
    const result = confirmPluginEnablement([alpha, beta], 'alpha', true);
    expect(result).toEqual([{ ...alpha, enabled: true }, beta]);
    expect(result[1]).toBe(beta);
    expect(alpha.enabled).toBe(false);
  });

  it('is idempotent and never toggles a newer value or recreates missing rows', () => {
    const plugins = [{ id: 'alpha', enabled: true }];
    expect(confirmPluginEnablement(plugins, 'alpha', true)).toEqual(plugins);
    expect(confirmPluginEnablement(plugins, 'alpha', false)).toEqual([{ id: 'alpha', enabled: false }]);
    expect(confirmPluginEnablement(plugins, 'missing', false)).toEqual(plugins);
  });
});

describe('projectPluginTally', () => {
  const retained = [
    { id: 'alpha', enabled: true },
    { id: 'beta', enabled: false },
  ];

  it('counts an empty list as a real zero rather than a missing reading', () => {
    expect(projectPluginTally([], 'confirmed')).toEqual({ count: 0, enabled: 0 });
  });

  it('counts a confirmed list and only the plugins that read as enabled', () => {
    expect(projectPluginTally(retained, 'confirmed')).toEqual({ count: 2, enabled: 1 });
    expect(projectPluginTally([...retained, { id: 'gamma', enabled: true }], 'confirmed')).toEqual({
      count: 3,
      enabled: 2,
    });
  });

  it('states no count while a read is still in flight, however many plugins are held', () => {
    expect(projectPluginTally(retained, 'pending')).toEqual({ count: null, enabled: null });
    expect(projectPluginTally([], 'pending')).toEqual({ count: null, enabled: null });
  });

  it('states no count after a failed read, even over a list a previous read confirmed', () => {
    expect(projectPluginTally(retained, 'failed')).toEqual({ count: null, enabled: null });
    expect(projectPluginTally([], 'failed')).toEqual({ count: null, enabled: null });
  });

  it('keeps a confirmed count after a confirmed toggle, and drops it only when the read itself fails', () => {
    const toggled = confirmPluginEnablement(retained, 'beta', true);
    expect(projectPluginTally(toggled, 'confirmed')).toEqual({ count: 2, enabled: 2 });
    expect(projectPluginTally(toggled, 'failed')).toEqual({ count: null, enabled: null });
  });
});
