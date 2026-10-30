import type { ReactNode } from 'react';
import { Eye, EyeOff, TriangleAlert } from 'lucide-react';
import { Badge, Button, Field, Input, Panel, PanelHeader, Select, Switch, Textarea, cn } from '../../design';
import { OPENROUTER_MODELS, type JarvisBackend, type JarvisConfig } from '../../domain/types';
import { BACKENDS } from '../models/backends';
import { ChoiceCards } from './ChoiceCards';
import {
  DEFAULT_BRIDGE_PORT,
  OPENCODE_DEFAULT_TIMEOUT_MS,
  SHELL_DEFAULT_TIMEOUT_MS,
  clampTimeout,
  sectionDomId,
  type SectionId,
} from './config-draft';

export type ConfigUpdater = (fn: (config: JarvisConfig) => JarvisConfig) => void;

/** A titled settings panel carrying the anchor id the section index scrolls to. */
export function SettingsPanel({
  id,
  title,
  description,
  actions,
  children,
}: {
  id: SectionId;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Panel id={sectionDomId(id)} aria-label={title} data-settings-section={id} className="scroll-mt-8">
      <PanelHeader level={2} title={title} description={description} actions={actions} />
      <div className="space-y-4">{children}</div>
    </Panel>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  toggleLabel,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  toggleLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-6 rounded-lg border border-line bg-sunken px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        {description && <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{description}</p>}
      </div>
      <Switch pressed checked={checked} onChange={onChange} aria-label={toggleLabel} />
    </div>
  );
}

/** A static (non-live) warning. Selecting a risky option is the user's own action, so it is not announced as an alert. */
function Callout({ children }: { children: ReactNode }) {
  return (
    <div role="note" className={cn('flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn-wash px-3 py-2.5 text-[12.5px] leading-snug text-ink')}>
      <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0 text-warn" />
      <div>{children}</div>
    </div>
  );
}

const SEARCH_PROVIDERS = [
  { id: 'duckduckgo', title: 'DuckDuckGo', description: 'No key needed.' },
  { id: 'brave', title: 'Brave', description: 'Higher quality; needs an API key.' },
  { id: 'tavily', title: 'Tavily', description: 'Built for agents; needs an API key.' },
] as const;

export function ConfigPanels({
  draft,
  update,
  showKeys,
  onToggleKeys,
}: {
  draft: JarvisConfig;
  update: ConfigUpdater;
  showKeys: boolean;
  onToggleKeys: () => void;
}) {
  const set = <K extends keyof JarvisConfig>(key: K, value: JarvisConfig[K]) => update((c) => ({ ...c, [key]: value }));
  // Spread the existing nested block so fields the UI does not know about survive.
  const patch = <K extends keyof JarvisConfig>(key: K, partial: Partial<JarvisConfig[K]>) =>
    update((c) => ({ ...c, [key]: { ...(c[key] as object), ...(partial as object) } }));

  const keyType = showKeys ? 'text' : 'password';
  const knownOpenRouterModel = OPENROUTER_MODELS.some((m) => m.id === draft.openrouter.model);

  return (
    <>
      <SettingsPanel
        id="backend"
        title="Inference backend"
        description="Which engine answers new Session turns. Model profiles pick the model within it."
      >
        <ChoiceCards<JarvisBackend>
          aria-label="Inference backend"
          columns={2}
          value={draft.active_backend}
          onChange={(id) => set('active_backend', id)}
          options={BACKENDS.map((b) => ({
            id: b.id,
            title: b.label,
            description: b.description,
            badge: (
              <Badge tone={b.local ? 'ok' : 'info'} size="xs">
                {b.local ? 'local' : 'cloud'}
              </Badge>
            ),
          }))}
        />
      </SettingsPanel>

      <SettingsPanel
        id="keys"
        title="Provider keys"
        description="Used by the runtime fallback cascade; save before starting a Session."
        actions={
          <Button
            variant="ghost"
            size="xs"
            icon={showKeys ? <EyeOff /> : <Eye />}
            onClick={onToggleKeys}
            aria-label={showKeys ? 'Hide provider API keys' : 'Show provider API keys'}
          >
            {showKeys ? 'Hide keys' : 'Show keys'}
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="OpenRouter API key" className="sm:col-span-2">
            {(id) => (
              <Input
                id={id}
                mono
                autoComplete="off"
                type={keyType}
                value={draft.openrouter?.api_key ?? ''}
                placeholder="sk-or-v1-..."
                onChange={(e) => patch('openrouter', { api_key: e.target.value })}
              />
            )}
          </Field>
          <Field label="OpenCode Go API key">
            {(id) => (
              <Input
                id={id}
                mono
                autoComplete="off"
                type={keyType}
                value={draft.opencode_go?.api_key ?? ''}
                placeholder="OpenCode Go key"
                onChange={(e) => patch('opencode_go', { api_key: e.target.value })}
              />
            )}
          </Field>
          <Field label="OpenCode Zen API key">
            {(id) => (
              <Input
                id={id}
                mono
                autoComplete="off"
                type={keyType}
                value={draft.opencode_zen?.api_key ?? ''}
                placeholder="OpenCode Zen key"
                onChange={(e) => patch('opencode_zen', { api_key: e.target.value })}
              />
            )}
          </Field>
        </div>

        <div className="border-t border-line pt-4">
          <h3 className="text-[12.5px] font-semibold text-ink">OpenCode first-token timeout</h3>
          <p className="mb-3 mt-0.5 text-[11.5px] leading-snug text-ink-3">
            After this many milliseconds with no response bytes, Jarvis abandons that provider and advances the fallback cascade.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="OpenCode Go (ms)">
              {(id) => (
                <Input
                  id={id}
                  mono
                  type="number"
                  min={1000}
                  step={1000}
                  value={draft.opencode_go?.first_token_timeout_ms ?? OPENCODE_DEFAULT_TIMEOUT_MS}
                  onChange={(e) => patch('opencode_go', { first_token_timeout_ms: clampTimeout(e.target.value, OPENCODE_DEFAULT_TIMEOUT_MS) })}
                />
              )}
            </Field>
            <Field label="OpenCode Zen (ms)">
              {(id) => (
                <Input
                  id={id}
                  mono
                  type="number"
                  min={1000}
                  step={1000}
                  value={draft.opencode_zen?.first_token_timeout_ms ?? OPENCODE_DEFAULT_TIMEOUT_MS}
                  onChange={(e) => patch('opencode_zen', { first_token_timeout_ms: clampTimeout(e.target.value, OPENCODE_DEFAULT_TIMEOUT_MS) })}
                />
              )}
            </Field>
          </div>
        </div>
      </SettingsPanel>

      <SettingsPanel
        id="model"
        title="Model"
        description={
          draft.active_backend === 'openrouter'
            ? 'Pick a curated model or enter any OpenRouter model id.'
            : draft.active_backend === 'llama_cpp'
              ? 'llama.cpp paths are machine-specific; when blank they come from the JARVIS_LLAMA_* environment variables.'
              : draft.active_backend === 'claude_cli'
                ? 'Leave blank to let the claude binary choose its default model.'
                : 'The model tag Ollama should run.'
        }
      >
        {draft.active_backend === 'openrouter' ? (
          <div className="grid gap-4">
            <Field label="OpenRouter model">
              {(id) => (
                <Select id={id} value={knownOpenRouterModel ? draft.openrouter.model : ''} onChange={(e) => patch('openrouter', { model: e.target.value })}>
                  <option value="">Custom model...</option>
                  {OPENROUTER_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.pricing}) — {m.description}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Model id">
              {(id) => (
                <Input
                  id={id}
                  mono
                  type="text"
                  value={draft.openrouter.model}
                  placeholder="Enter custom model ID"
                  onChange={(e) => patch('openrouter', { model: e.target.value })}
                />
              )}
            </Field>
          </div>
        ) : draft.active_backend === 'llama_cpp' ? (
          <div className="grid gap-4">
            <Field label="Model alias">
              {(id) => (
                <Input
                  id={id}
                  mono
                  type="text"
                  value={draft.llama_cpp?.model ?? ''}
                  placeholder="llama.cpp model alias"
                  onChange={(e) => patch('llama_cpp', { model: e.target.value })}
                />
              )}
            </Field>
            <Field label="llama.cpp server_path" hint="llama-server executable path (or JARVIS_LLAMA_SERVER_PATH).">
              {(id) => (
                <Input
                  id={id}
                  mono
                  type="text"
                  value={draft.llama_cpp?.server_path ?? ''}
                  placeholder="/opt/llama.cpp/build/bin/llama-server"
                  onChange={(e) => patch('llama_cpp', { server_path: e.target.value })}
                />
              )}
            </Field>
            <Field label="llama.cpp model_path" hint="GGUF model file path (or JARVIS_LLAMA_MODEL_PATH).">
              {(id) => (
                <Input
                  id={id}
                  mono
                  type="text"
                  value={draft.llama_cpp?.model_path ?? ''}
                  placeholder="/models/model.gguf"
                  onChange={(e) => patch('llama_cpp', { model_path: e.target.value })}
                />
              )}
            </Field>
            <Field label="llama.cpp mtp_path" hint="Optional MTP draft head path (or JARVIS_LLAMA_MTP_PATH).">
              {(id) => (
                <Input
                  id={id}
                  mono
                  type="text"
                  value={draft.llama_cpp?.mtp_path ?? ''}
                  placeholder="/models/mtp-draft.gguf"
                  onChange={(e) => patch('llama_cpp', { mtp_path: e.target.value })}
                />
              )}
            </Field>
            <p className="rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[11px] text-ink-3">
              Server: {draft.llama_cpp?.base_url ?? 'http://127.0.0.1:8080/v1'} · context {draft.llama_cpp?.context_window ?? 16384} · reasoning budget{' '}
              {draft.llama_cpp?.reasoning_budget ?? 1536}
            </p>
          </div>
        ) : draft.active_backend === 'claude_cli' ? (
          <Field label="Claude model">
            {(id) => (
              <Input
                id={id}
                mono
                type="text"
                value={draft.claude_cli?.model ?? ''}
                placeholder="e.g., sonnet (blank = claude default)"
                onChange={(e) => patch('claude_cli', { model: e.target.value === '' ? undefined : e.target.value })}
              />
            )}
          </Field>
        ) : (
          <Field label="Ollama model">
            {(id) => (
              <Input
                id={id}
                mono
                type="text"
                value={draft.ollama.model}
                placeholder="e.g., qwen2.5-coder:7b"
                onChange={(e) => patch('ollama', { model: e.target.value })}
              />
            )}
          </Field>
        )}
      </SettingsPanel>

      <SettingsPanel id="orchestration" title="Orchestration" description="Runs coordinator, tool, review, and synthesis stages. Turn it off for a faster single-pass response.">
        <ToggleRow
          label={draft.orchestrator?.enabled ? 'Multi-stage orchestration' : 'Single-pass runtime'}
          checked={Boolean(draft.orchestrator?.enabled)}
          toggleLabel="Toggle orchestration runtime"
          onChange={(enabled) => patch('orchestrator', { enabled })}
        />
      </SettingsPanel>

      <SettingsPanel id="endpoints" title="Endpoints" description="Base URLs the Bun server calls for each Inference backend.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ollama URL">
            {(id) => <Input id={id} mono type="text" value={draft.ollama.base_url} onChange={(e) => patch('ollama', { base_url: e.target.value })} />}
          </Field>
          <Field label="OpenRouter URL">
            {(id) => <Input id={id} mono type="text" value={draft.openrouter.base_url} onChange={(e) => patch('openrouter', { base_url: e.target.value })} />}
          </Field>
        </div>
      </SettingsPanel>

      <SettingsPanel id="prompt" title="System prompt" description="Prepended to every Session turn. An Agent's soul.md adds its own identity on top.">
        <Field label="System prompt text">
          {(id) => <Textarea id={id} rows={6} value={draft.system_prompt} onChange={(e) => set('system_prompt', e.target.value)} />}
        </Field>
      </SettingsPanel>

      <SettingsPanel id="bridge" title="Bridge" description="The legacy Hermes bridge listener. It is not the chat path; Session turns do not use it.">
        <ToggleRow label="Enable Bridge" checked={draft.bridge_enabled} toggleLabel="Toggle bridge" onChange={(enabled) => set('bridge_enabled', enabled)} />
        <Field label="Bridge Port" className="max-w-40">
          {(id) => (
            <Input
              id={id}
              mono
              type="number"
              value={draft.bridge_port}
              onChange={(e) => set('bridge_port', parseInt(e.target.value) || DEFAULT_BRIDGE_PORT)}
            />
          )}
        </Field>
      </SettingsPanel>

      <SettingsPanel
        id="search"
        title="Web search"
        description="DuckDuckGo needs no key. Brave and Tavily are higher quality but require one — with a provider selected and no key set, search silently falls back to DuckDuckGo."
      >
        <ChoiceCards<'duckduckgo' | 'brave' | 'tavily'>
          aria-label="Web search provider"
          columns={3}
          value={draft.web_search.provider}
          onChange={(provider) => patch('web_search', { provider })}
          options={SEARCH_PROVIDERS.map((p) => ({ id: p.id, title: p.title, description: p.description }))}
        />
        {draft.web_search.provider === 'brave' && (
          <Field label="Brave API key">
            {(id) => (
              <Input
                id={id}
                mono
                autoComplete="off"
                type="password"
                value={draft.web_search.brave_api_key}
                placeholder="Brave Search API key"
                onChange={(e) => patch('web_search', { brave_api_key: e.target.value })}
              />
            )}
          </Field>
        )}
        {draft.web_search.provider === 'tavily' && (
          <Field label="Tavily API key">
            {(id) => (
              <Input
                id={id}
                mono
                autoComplete="off"
                type="password"
                value={draft.web_search.tavily_api_key}
                placeholder="Tavily API key"
                onChange={(e) => patch('web_search', { tavily_api_key: e.target.value })}
              />
            )}
          </Field>
        )}
      </SettingsPanel>

      <SettingsPanel id="shell" title="Shell" description="How the shell tool finds bash, and how long a command may run.">
        <Field
          label={
            <>
              Bash interpreter path <span className="font-normal text-ink-3">(blank = auto-resolve Git Bash)</span>
            </>
          }
          hint="Never point this at System32\bash.exe — that is the WSL launcher, not Git Bash, and resolves paths in a different filesystem namespace."
        >
          {(id) => (
            <Input
              id={id}
              mono
              type="text"
              value={draft.tools.bash_path}
              placeholder="C:\Program Files\Git\bin\bash.exe"
              onChange={(e) => patch('tools', { bash_path: e.target.value })}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Shell timeout ceiling (ms)">
            {(id) => (
              <Input
                id={id}
                mono
                type="number"
                min={1000}
                step={1000}
                value={draft.tools.shell_timeout_max_ms}
                onChange={(e) => patch('tools', { shell_timeout_max_ms: clampTimeout(e.target.value, SHELL_DEFAULT_TIMEOUT_MS) })}
              />
            )}
          </Field>
          <Field label="Jarvis path" hint="Auto-detected from workspace">
            {(id) => <Input id={id} mono type="text" readOnly value={draft.jarvis_path} className="cursor-not-allowed text-ink-3" />}
          </Field>
        </div>
      </SettingsPanel>

      <SettingsPanel
        id="claude"
        title="Claude CLI auth"
        description="How the Claude Code CLI Inference backend authenticates. Proxy mode keeps routing free."
      >
        <ToggleRow
          label="Enable Claude CLI"
          description="Required before the Claude Code CLI backend can answer, and for the proxy to start at launch."
          checked={Boolean(draft.claude_cli.enabled)}
          toggleLabel="Toggle Claude CLI"
          onChange={(enabled) => patch('claude_cli', { enabled })}
        />
        <ChoiceCards<'proxy' | 'subscription'>
          aria-label="Claude CLI auth mode"
          columns={2}
          value={draft.claude_cli.auth_mode}
          onChange={(auth_mode) => patch('claude_cli', { auth_mode })}
          options={[
            { id: 'proxy', title: 'Proxy', description: 'Free — local Ollama / OpenRouter' },
            { id: 'subscription', title: 'Subscription', description: 'Spends your Claude quota', tone: 'danger' },
          ]}
        />
        {draft.claude_cli.auth_mode === 'subscription' && (
          <Callout>
            Subscription mode bypasses the free local proxy and talks to Anthropic directly — every request here spends your Claude subscription quota. The
            automated executor delegate always refuses subscription mode and falls back to the free native path regardless of this setting, so this only
            affects manual/interactive CLI use.
          </Callout>
        )}
      </SettingsPanel>
    </>
  );
}
