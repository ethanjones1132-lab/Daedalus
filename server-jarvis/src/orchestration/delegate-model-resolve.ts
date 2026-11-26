/**
 * Pick the first delegate model whose CLI launch config is actually available.
 *
 * This is the availability-probing half of delegate model resolution,
 * extracted from `PipelineExecutor`'s inline candidate loop so the harness
 * maker resolves "auto" through the same rules instead of handing the CLI
 * `--model auto`. Candidate ordering still comes from
 * `enumerateDelegateModelCandidates` in `./delegate-model-select`; this module
 * only probes them and returns the matching config, or the tried ids.
 */

import type { JarvisConfig } from "../config";
import type { DelegateModelSelection } from "./delegate-model-select";

export interface DelegateModelResolution {
  selection: DelegateModelSelection;
  /** The input config with `claude_cli.delegate.model` replaced by the concrete id. */
  config: JarvisConfig;
}

export interface ResolveAvailableDelegateModelInput {
  /** Base config; only the delegate model is replaced per candidate. */
  config: JarvisConfig;
  /** Ordered candidates from `enumerateDelegateModelCandidates`. */
  candidates: readonly DelegateModelSelection[];
  /** Launch-readiness probe for one candidate config. */
  isAvailable: (config: JarvisConfig) => Promise<boolean>;
  /** Called for a candidate whose probe returned false. */
  onUnavailable?: (selection: DelegateModelSelection) => void;
  /** Called when the probe itself threw; the next candidate is still tried. */
  onAvailabilityError?: (selection: DelegateModelSelection, error: unknown) => void;
}

export interface ResolveAvailableDelegateModelResult {
  resolution?: DelegateModelResolution;
  /** Every candidate model id that was considered, in order. */
  tried: string[];
}

/** A copy of `config` pinned to one concrete delegate model id. */
export function delegateConfigForModel(config: JarvisConfig, model: string): JarvisConfig {
  return {
    ...config,
    claude_cli: {
      ...config.claude_cli,
      delegate: {
        ...config.claude_cli.delegate,
        model,
      },
    },
  };
}

export async function resolveAvailableDelegateModel(
  input: ResolveAvailableDelegateModelInput,
): Promise<ResolveAvailableDelegateModelResult> {
  const tried = input.candidates.map((candidate) => candidate.model);
  for (const candidate of input.candidates) {
    const config = delegateConfigForModel(input.config, candidate.model);
    let available = false;
    try {
      available = await input.isAvailable(config);
    } catch (error) {
      input.onAvailabilityError?.(candidate, error);
      continue;
    }
    if (!available) {
      input.onUnavailable?.(candidate);
      continue;
    }
    return { resolution: { selection: candidate, config }, tried };
  }
  return { tried };
}
