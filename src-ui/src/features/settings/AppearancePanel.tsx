import { Segmented } from '../../design';
import { useTheme, type Theme } from '../../hooks/useTheme';
import { SettingsPanel } from './ConfigPanels';

/** Theme choice. Every useTheme instance stays in sync (titlebar toggle included). */
export function AppearancePanel() {
  const { theme, setTheme, choice } = useTheme();
  return (
    <SettingsPanel id="appearance" title="Appearance" description="Stored on this machine and in the Jarvis database, so it follows you across launches.">
      <Segmented<Theme>
        aria-label="Theme"
        className="w-full max-w-lg"
        value={theme}
        onChange={setTheme}
        options={[
          { id: 'dark', label: 'Ink', description: 'Warm near-black, brass accent' },
          { id: 'light', label: 'Vellum', description: 'Daylight drafting paper' },
        ]}
      />
      {choice.message && <p role={choice.confirmed ? 'status' : 'alert'} className="mt-3 text-xs text-ink-3">{choice.message}</p>}
    </SettingsPanel>
  );
}
