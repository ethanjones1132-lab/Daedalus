import { defineCommands } from '../registry';

const settings = new Map<string, string>();

defineCommands({
  get_setting: ({ key }) => settings.get(String(key)) ?? null,
  set_setting: ({ key, value }) => {
    settings.set(String(key), String(value));
    return null;
  },
});
