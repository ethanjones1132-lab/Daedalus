import { useEffect, useState } from 'react';
import { Segmented } from '../../design';
import { useTheme, type Theme } from '../../hooks/useTheme';
import { SettingsPanel } from './ConfigPanels';

const appliedTheme = (): Theme => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

/**
 * Theme choice. The shell's titlebar toggle owns a separate useTheme instance,
 * so this mirrors the attribute that is actually applied to <html> instead of
 * trusting its own copy of the state.
 */
export function AppearancePanel() {
  const { setTheme } = useTheme();
  const [applied, setApplied] = useState<Theme>(appliedTheme);

  useEffect(() => {
    setApplied(appliedTheme());
    const observer = new MutationObserver(() => setApplied(appliedTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return (
    <SettingsPanel id="appearance" title="Appearance" description="Stored on this machine and in the Jarvis database, so it follows you across launches.">
      <Segmented<Theme>
        aria-label="Theme"
        className="w-full max-w-lg"
        value={applied}
        onChange={(next) => {
          setApplied(next);
          setTheme(next);
        }}
        options={[
          { id: 'dark', label: 'Ink', description: 'Warm near-black, brass accent' },
          { id: 'light', label: 'Vellum', description: 'Daylight drafting paper' },
        ]}
      />
    </SettingsPanel>
  );
}
