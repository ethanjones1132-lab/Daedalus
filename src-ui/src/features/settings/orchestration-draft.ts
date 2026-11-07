import type { JarvisConfig, RoutingStage, StageFallbacks, StagePrimary, StageTarget } from '../../domain/types';

export function setStagePrimary(config: JarvisConfig, stage: RoutingStage, primary: StagePrimary): JarvisConfig {
  const orchestrator = config.orchestrator ?? { enabled: false };
  return {
    ...config,
    orchestrator: {
      ...orchestrator,
      stage_models: { ...(orchestrator.stage_models ?? {}), [stage]: primary },
    },
  };
}

export function setStageFallbacks(config: JarvisConfig, stage: RoutingStage, fallbacks: StageFallbacks): JarvisConfig {
  const orchestrator = config.orchestrator ?? { enabled: false };
  return {
    ...config,
    orchestrator: {
      ...orchestrator,
      fallback_chains: { ...(orchestrator.fallback_chains ?? {}), [stage]: fallbacks },
    },
  };
}

export function moveFallback(config: JarvisConfig, stage: RoutingStage, from: number, to: number): JarvisConfig {
  const current = config.orchestrator.fallback_chains?.[stage];
  if (!Array.isArray(current) || from < 0 || from >= current.length || to < 0 || to >= current.length || from === to) return config;
  const next = [...current];
  const [target] = next.splice(from, 1);
  next.splice(to, 0, target);
  return setStageFallbacks(config, stage, next as StageTarget[]);
}

export function replaceFallback(config: JarvisConfig, stage: RoutingStage, index: number, target: StageTarget): JarvisConfig {
  const current = config.orchestrator.fallback_chains?.[stage];
  if (!Array.isArray(current) || index < 0 || index >= current.length) return config;
  const next = [...current] as StageTarget[];
  next[index] = target;
  return setStageFallbacks(config, stage, next);
}

export function removeFallback(config: JarvisConfig, stage: RoutingStage, index: number): JarvisConfig {
  const current = config.orchestrator.fallback_chains?.[stage];
  if (!Array.isArray(current) || index < 0 || index >= current.length) return config;
  return setStageFallbacks(config, stage, current.filter((_, candidate) => candidate !== index) as StageTarget[]);
}
