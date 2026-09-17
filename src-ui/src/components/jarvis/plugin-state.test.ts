import { describe, expect, it } from 'vitest';
import { confirmPluginEnablement } from './plugin-state';

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
