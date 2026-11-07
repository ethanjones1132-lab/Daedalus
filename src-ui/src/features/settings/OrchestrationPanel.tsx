import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDown, ArrowUp, CircleStop, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Badge, Button, Field, Input, Panel, PanelHeader, Select, StatusLine, Switch } from '../../design';
import type {
  JarvisConfig,
  RouteDiagnosticResult,
  RoutingProvider,
  RoutingStage,
  StageFallbacks,
  StagePrimary,
  StageTarget,
} from '../../domain/types';
import { ChoiceCards } from './ChoiceCards';
import { sectionDomId } from './config-draft';
import { moveFallback, removeFallback, replaceFallback, setStageFallbacks, setStagePrimary } from './orchestration-draft';

const STAGES: Array<{ id: RoutingStage; label: string; description: string }> = [
  { id: 'coordinator', label: 'Coordinator', description: 'Chooses the next orchestration action.' },
  { id: 'planner', label: 'Planner', description: 'Builds a plan for the requested work.' },
  { id: 'executor', label: 'Executor', description: 'Performs the selected work.' },
  { id: 'reviewer', label: 'Reviewer', description: 'Checks the work and identifies gaps.' },
  { id: 'rewriter', label: 'Rewriter', description: 'Revises work when review requests changes.' },
  { id: 'synthesizer', label: 'Synthesizer', description: 'Produces the final response.' },
];

const PROVIDERS: Array<{ id: RoutingProvider; label: string; kind: 'local' | 'cloud' | 'self-hosted' }> = [
  { id: 'llama_cpp', label: 'llama.cpp', kind: 'local' },
  { id: 'ollama', label: 'Ollama', kind: 'local' },
  { id: 'vllm', label: 'vLLM', kind: 'self-hosted' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'cloud' },
  { id: 'opencode_zen', label: 'OpenCode Zen', kind: 'cloud' },
  { id: 'opencode_go', label: 'OpenCode Go', kind: 'cloud' },
];

function defaultModel(config: JarvisConfig, provider: RoutingProvider): string {
  if (provider === 'llama_cpp') return config.llama_cpp?.model ?? '';
  if (provider === 'ollama') return config.ollama?.model ?? '';
  if (provider === 'vllm') return config.vllm?.model ?? '';
  if (provider === 'openrouter') return config.openrouter?.model ?? '';
  const agents = config.orchestrator?.agents;
  if (Array.isArray(agents)) {
    const agent = agents.find((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      const row = candidate as Record<string, unknown>;
      return row.provider === provider && typeof row.model_id === 'string' && row.enabled !== false;
    }) as Record<string, unknown> | undefined;
    if (typeof agent?.model_id === 'string') return agent.model_id;
  }
  return provider === 'opencode_go' ? 'deepseek-v4-flash' : 'north-mini-code-free';
}

function configuredTarget(value: StagePrimary | undefined): StageTarget | undefined {
  return value && value !== 'automatic' ? value : undefined;
}

function newOperationId(): string {
  return `settings-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function routeResult(result: RouteDiagnosticResult): RouteDiagnosticResult {
  return {
    ...result,
    attempts: Array.isArray(result.attempts) ? result.attempts : [],
    rejected_candidates: Array.isArray(result.rejected_candidates) ? result.rejected_candidates : [],
  };
}

function TargetEditor({
  config,
  stage,
  label,
  value,
  onChange,
  readOnlyLlamaAlias = true,
}: {
  config: JarvisConfig;
  stage: RoutingStage;
  label: string;
  value: StageTarget;
  onChange: (target: StageTarget) => void;
  readOnlyLlamaAlias?: boolean;
}) {
  const provider = PROVIDERS.find((entry) => entry.id === value.provider);
  const isLlama = value.provider === 'llama_cpp';
  const modelValue = value.model;
  const configuredLlamaAlias = config.llama_cpp?.model ?? '';
  const cloudBlocked = provider?.kind === 'cloud'
    && (config.active_backend === 'llama_cpp' || config.active_backend === 'ollama')
    && config.orchestrator.allow_cloud_helpers !== true;

  return (
    <div data-route-stage={stage} className="grid min-w-0 gap-3 rounded-lg border border-line bg-sunken p-3 sm:grid-cols-[minmax(140px,0.75fr)_minmax(0,1.25fr)]">
      <Field label={`${label} provider`}>
        {(id) => (
          <Select
            id={id}
            aria-label={`${label} provider`}
            value={value.provider}
            onChange={(event) => {
              const nextProvider = event.target.value as RoutingProvider;
              onChange({ provider: nextProvider, model: defaultModel(config, nextProvider) });
            }}
          >
            {PROVIDERS.map((option) => (
              <option key={option.id} value={option.id}>{option.label} · {option.kind}</option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label={`${label} model`}
        hint={isLlama ? 'Uses the one model currently served by llama.cpp.' : 'Model IDs are kept exactly as entered, including / and :.'}
      >
        {(id) => (
          <Input
            id={id}
            aria-label={`${label} model`}
            mono
            value={modelValue}
            readOnly={isLlama && readOnlyLlamaAlias}
            placeholder={isLlama ? 'Configure the llama.cpp serving alias above' : 'Enter a model ID'}
            onChange={(event) => onChange({ ...value, model: event.target.value })}
          />
        )}
      </Field>
      {cloudBlocked && (
        <p className="sm:col-span-2 text-[11.5px] leading-snug text-warn">
          This {provider?.label} target is configured but blocked while cloud helpers are off.
        </p>
      )}
      {isLlama && value.model !== configuredLlamaAlias && (
        <div className="sm:col-span-2 space-y-2">
          <p className="text-[11.5px] leading-snug text-warn">
            This target differs from the configured llama.cpp alias “{configuredLlamaAlias}”. Update the target or choose Automatic before saving.
          </p>
          <Button size="xs" disabled={!configuredLlamaAlias} aria-label={`Use configured llama.cpp model for ${label}`}
            onClick={() => onChange({ ...value, model: configuredLlamaAlias })}>
            Use configured llama.cpp model
          </Button>
        </div>
      )}
    </div>
  );
}

export function OrchestrationPanel({
  config,
  update,
}: {
  config: JarvisConfig;
  update: (config: JarvisConfig) => void;
}) {
  const [result, setResult] = useState<RouteDiagnosticResult | null>(null);
  const [probeErrorStage, setProbeErrorStage] = useState<RoutingStage | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [activeView, setActiveView] = useState<{ operationId: string; stage: RoutingStage; cancelling: boolean } | null>(null);
  const activeProbe = useRef<{ operationId: string; stage: RoutingStage; signature: string; cancelling: boolean } | null>(null);
  const mounted = useRef(false);
  const signature = useMemo(() => JSON.stringify(config), [config]);
  const signatureRef = useRef(signature);
  signatureRef.current = signature;

  const cancelActive = useCallback((announce = true) => {
    const active = activeProbe.current;
    if (!active || active.cancelling) return;
    active.cancelling = true;
    if (announce) {
      setCancelling(true);
      setActiveView((current) => current?.operationId === active.operationId ? { ...current, cancelling: true } : current);
    }
    void invoke('jarvis_cancel_orchestration_route_test', { operationId: active.operationId }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const active = activeProbe.current;
    const cancelledActive = Boolean(active && active.signature !== signature);
    if (active && active.signature !== signature) {
      cancelActive(false);
      setActiveView((current) => current?.operationId === active.operationId ? { ...current, cancelling: true } : current);
    }
    setResult(null);
    setProbeErrorStage(null);
    setCancelling(Boolean(cancelledActive));
  }, [signature, cancelActive]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelActive(false);
      activeProbe.current = null;
    };
  }, [cancelActive]);

  const testRoute = async (stage: RoutingStage) => {
    if (activeProbe.current) return;
    const operationId = newOperationId();
    const startedWith = signature;
    activeProbe.current = { operationId, stage, signature: startedWith, cancelling: false };
    setActiveView({ operationId, stage, cancelling: false });
    setResult(null);
    setProbeErrorStage(null);
    setCancelling(false);
    try {
      const response = await invoke<RouteDiagnosticResult>('jarvis_test_orchestration_route', {
        operationId,
        stage,
        config,
      });
      if (activeProbe.current?.operationId === operationId) {
        activeProbe.current = null;
        if (mounted.current) {
          setActiveView(null);
          setCancelling(false);
        }
      }
      if (mounted.current && signatureRef.current === startedWith) setResult(routeResult(response));
    } catch {
      if (activeProbe.current?.operationId === operationId) {
        activeProbe.current = null;
        if (mounted.current) setActiveView(null);
      }
      if (mounted.current) {
        setCancelling(false);
        if (signatureRef.current === startedWith) setProbeErrorStage(stage);
      }
    }
  };

  const explicitPrimary = (stage: RoutingStage): StageTarget | undefined =>
    configuredTarget(config.orchestrator.stage_models?.[stage]);

  const setPrimary = (stage: RoutingStage, primary: StagePrimary) => update(setStagePrimary(config, stage, primary));
  const setFallbacks = (stage: RoutingStage, fallbacks: StageFallbacks) => update(setStageFallbacks(config, stage, fallbacks));
  const cloudAllowed = config.orchestrator.allow_cloud_helpers === true;
  const active = activeView;

  return (
    <Panel id={sectionDomId('orchestration')} aria-label="Orchestration" data-settings-section="orchestration" className="scroll-mt-8">
      <PanelHeader
        level={2}
        title="Orchestration"
        description="Choose Direct or Orchestrated turns, then set the provider and fallback order for each stage."
      />
      <div className="space-y-5">
        <ChoiceCards<'direct' | 'orchestrated'>
          aria-label="Orchestration mode"
          columns={2}
          value={config.orchestrator.enabled ? 'orchestrated' : 'direct'}
          onChange={(mode) => update({ ...config, orchestrator: { ...config.orchestrator, enabled: mode === 'orchestrated' } })}
          options={[
            { id: 'direct', title: 'Direct', ariaLabel: 'Direct', description: 'Use the selected inference backend for a single-pass turn.' },
            { id: 'orchestrated', title: 'Orchestrated', ariaLabel: 'Orchestrated', description: 'Use configured coordinator, planner, execution, review, and synthesis stages.' },
          ]}
        />

        <div className="flex flex-col gap-3 rounded-lg border border-line bg-sunken px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink">Allow cloud helpers</p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">With a local inference backend, turn this on to permit cloud helpers. A selected cloud backend already permits cloud inference. Missing setting means off.</p>
          </div>
          <Switch
            checked={cloudAllowed}
            aria-label="Allow cloud helpers"
            onChange={(allow_cloud_helpers) => update({ ...config, orchestrator: { ...config.orchestrator, allow_cloud_helpers } })}
          />
        </div>

        <p role="note" className="rounded-md border border-line bg-sunken px-3 py-2 text-[11.5px] leading-relaxed text-ink-3">
          Stage policies apply to Orchestrated turns. They are retained in Direct mode. A route test in Direct mode is an isolated stage diagnostic and does not change the Direct Session path.
        </p>
        <p className="text-[11.5px] leading-snug text-ink-3">
          Automatic follows the runtime model ranking. An explicit primary runs first; the ordered custom list is the complete fallback tail. An empty custom list disables fallback. Save applies settings to newly started turns.
        </p>

        <div className="space-y-3">
          {STAGES.map((stage) => {
            const primary = explicitPrimary(stage.id);
            const fallbackValue = config.orchestrator.fallback_chains?.[stage.id] ?? 'automatic';
            const customFallbacks = Array.isArray(fallbackValue) ? fallbackValue : null;
            const probeResult = result?.stage === stage.id ? result : null;
            return (
              <section key={stage.id} aria-label={`${stage.label} routing`} className="min-w-0 space-y-3 rounded-lg border border-line-strong p-3 sm:p-4">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-[13px] font-semibold text-ink">{stage.label}</h3>
                    <p className="text-[11.5px] leading-snug text-ink-3">{stage.description}</p>
                  </div>
                  <Badge tone="info" size="xs">Stage route</Badge>
                </div>

                {primary ? (
                  <div className="space-y-2">
                    <TargetEditor
                      config={config}
                      stage={stage.id}
                      label={`${stage.id} primary`}
                      value={primary}
                      onChange={(target) => setPrimary(stage.id, target)}
                    />
                    <Button variant="ghost" size="xs" icon={<RotateCcw />} onClick={() => setPrimary(stage.id, 'automatic')}>
                      Use automatic {stage.id} primary
                    </Button>
                  </div>
                ) : (
                  <Field label={`${stage.id} primary provider`} hint="Automatic primary selection uses the runtime ranking for this stage.">
                    {(id) => (
                      <Select
                        id={id}
                        aria-label={`${stage.id} primary provider`}
                        value="automatic"
                        onChange={(event) => {
                          const nextProvider = event.target.value as RoutingProvider | 'automatic';
                          if (nextProvider === 'automatic') return;
                          setPrimary(stage.id, { provider: nextProvider, model: defaultModel(config, nextProvider) });
                        }}
                      >
                        <option value="automatic">Automatic</option>
                        {PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label} · {provider.kind}</option>)}
                      </Select>
                    )}
                  </Field>
                )}

                {fallbackValue === 'automatic' || fallbackValue === undefined ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-[11.5px] text-ink-3">Automatic fallback ranking</p>
                    <Button
                      size="xs"
                      onClick={() => setFallbacks(stage.id, [])}
                      aria-label={`Customize ${stage.id} fallbacks`}
                    >
                      Customize {stage.id} fallbacks
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3 rounded-lg border border-line bg-sunken p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-[12px] font-semibold text-ink-2">Ordered fallback candidates</h4>
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          size="xs"
                          icon={<Plus />}
                          disabled={customFallbacks!.length >= 8}
                          aria-label={`Add ${stage.id} fallback`}
                          onClick={() => {
                            const seed = primary ?? { provider: 'ollama' as const, model: defaultModel(config, 'ollama') };
                            setFallbacks(stage.id, [...customFallbacks!, { ...seed }]);
                          }}
                        >
                          Add {stage.id} fallback
                        </Button>
                        <Button size="xs" variant="ghost" icon={<RotateCcw />} onClick={() => setFallbacks(stage.id, 'automatic')}>
                          Use automatic {stage.id} fallbacks
                        </Button>
                      </div>
                    </div>
                    {customFallbacks!.length === 0 ? (
                      <p className="rounded-md border border-dashed border-line-strong px-3 py-3 text-[11.5px] text-ink-3">
                        No fallback candidates. This stage will stop after its primary fails.
                      </p>
                    ) : (
                      <ol className="space-y-2">
                        {customFallbacks!.map((target, index) => (
                          <li key={index} className="space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="d-label">Fallback {index + 1}</span>
                              <div className="flex gap-1">
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  icon={<ArrowUp />}
                                  aria-label={`Move ${stage.id} fallback ${index + 1} up`}
                                  disabled={index === 0}
                                  onClick={() => update(moveFallback(config, stage.id, index, index - 1))}
                                />
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  icon={<ArrowDown />}
                                  aria-label={`Move ${stage.id} fallback ${index + 1} down`}
                                  disabled={index === customFallbacks!.length - 1}
                                  onClick={() => update(moveFallback(config, stage.id, index, index + 1))}
                                />
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  icon={<Trash2 />}
                                  aria-label={`Remove ${stage.id} fallback ${index + 1}`}
                                  onClick={() => update(removeFallback(config, stage.id, index))}
                                />
                              </div>
                            </div>
                            <TargetEditor
                              config={config}
                              stage={stage.id}
                              label={`${stage.id} fallback ${index + 1}`}
                              value={target}
                              onChange={(next) => update(replaceFallback(config, stage.id, index, next))}
                            />
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}

                <div className="flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 text-[11.5px] leading-snug text-ink-3">
                    <p>Test uses this stage and the current unsaved draft; it never starts a Session or saves settings.</p>
                    {!config.orchestrator.enabled && <p className="mt-0.5">Direct is selected: this is an isolated stage diagnostic only.</p>}
                  </div>
                  {active?.stage === stage.id ? (
                    <Button size="xs" variant="danger" icon={<CircleStop />} onClick={() => cancelActive()} disabled={active.cancelling}>
                      {active.cancelling ? 'Cancelling route test...' : `Cancel ${stage.id} route test`}
                    </Button>
                  ) : (
                    <Button size="xs" icon={<CircleStop />} onClick={() => void testRoute(stage.id)} disabled={Boolean(active)}>
                      Test {stage.id} route
                    </Button>
                  )}
                </div>

                {probeErrorStage === stage.id && (
                  <p role="alert" className="text-[11.5px] text-err">Route test could not complete. The current draft is unchanged.</p>
                )}
                {cancelling && active?.stage === stage.id && <StatusLine>Cancel requested for this route test...</StatusLine>}
                {probeResult && (
                  <div role="region" aria-label={`${stage.label} route test result`} className="space-y-2 rounded-md border border-line bg-sunken p-3 text-[11.5px]">
                    <StatusLine busy={false} tone={probeResult.status === 'success' ? 'ok' : 'warn'}>
                      Route test {probeResult.status} · {probeResult.attempts.length} dispatched attempt{probeResult.attempts.length === 1 ? '' : 's'} · {probeResult.duration_ms} ms
                    </StatusLine>
                    <p>Request left this machine: {probeResult.left_machine ? 'yes' : 'no'}</p>
                    {probeResult.answered_by && <p>Answered by: {probeResult.answered_by.provider} · {probeResult.answered_by.model}</p>}
                    {probeResult.attempts.length > 0 && (
                      <ul aria-label="Route test attempts" className="space-y-1.5">
                        {probeResult.attempts.map((attempt, index) => (
                          <li key={`${index}:${attempt.provider}:${attempt.model}`} className="break-words">
                            Attempt {index + 1}: {attempt.provider} · {attempt.model} · {attempt.outcome} · {attempt.duration_ms} ms
                            {attempt.first_token_ms !== undefined && ` · first token ${attempt.first_token_ms} ms`}
                          </li>
                        ))}
                      </ul>
                    )}
                    {probeResult.rejected_candidates.length > 0 && (
                      <ul aria-label="Preflight rejections" className="space-y-1.5 text-warn">
                        {probeResult.rejected_candidates.map((candidate, index) => (
                          <li key={`${index}:${candidate.provider}:${candidate.model}`} className="break-words">
                            Preflight: {candidate.provider} · {candidate.model} · {candidate.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}
