// ═══════════════════════════════════════════════════════════════
// ── LlamaCppSetupNotice — first-run requirements for the default backend
// ═══════════════════════════════════════════════════════════════
//
// DD-164: Daedalus ships no llama-server and no model, and a fresh config has
// blank `llama_cpp.server_path`/`model_path`. The two path fields alone never
// said what belonged in them, so the first run read as a dead end. This notice
// names the parts (Unsloth's llama.cpp b12651 llama-server, the Inkling model
// GGUF, and the two CUDA DLLs the portable zip omits), where the paths come
// from, and the two ways out that need no artifact: adopt an already-running
// server, or pick an Inference backend that is already configured.
//
// Presentational only: `llamaCppSetupIssues` in server-jarvis/src/config.ts
// carries the same facts for save warnings and the backend-start refusal.

import { TriangleAlert } from 'lucide-react';
import { cn } from '../../design';

export const LLAMA_CPP_SETUP_LABEL = 'llama.cpp setup';

/** The model artifact the shipped AgentFast profile launches. */
export const LLAMA_CPP_MODEL_FILE = 'Inkling-2-Mini-UD-IQ3_XXS.gguf';

export interface LlamaCppSetupNoticeProps {
  serverPath?: string;
  modelPath?: string;
}

/** True when either required artifact path is blank. */
export function llamaCppNeedsSetup(serverPath?: string, modelPath?: string): boolean {
  return !serverPath?.trim() || !modelPath?.trim();
}

export default function LlamaCppSetupNotice({ serverPath, modelPath }: LlamaCppSetupNoticeProps) {
  if (!llamaCppNeedsSetup(serverPath, modelPath)) return null;

  const missingServer = !serverPath?.trim();
  const missingModel = !modelPath?.trim();
  const status = (missing: boolean) => (
    <span className={cn('font-medium', missing ? 'text-warn' : 'text-ok')}>{missing ? 'Missing.' : 'Set.'}</span>
  );

  return (
    <div
      role="note"
      aria-label={LLAMA_CPP_SETUP_LABEL}
      className={cn('rounded-lg border border-warn/30 bg-warn-wash px-3 py-2.5 text-[12.5px] leading-snug text-ink')}
    >
      <p className="flex items-center gap-2 font-medium">
        <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-warn" />
        llama.cpp is not set up yet
      </p>
      <p className="mt-1.5 text-ink-2">This install cannot launch its own llama-server until it has:</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-ink-2">
        <li>
          <span className="font-mono text-[11.5px]">llama_cpp.server_path</span>: llama-server from Unsloth's
          llama.cpp b12651 build (engine directory{' '}
          <span className="font-mono text-[11.5px]">llama-unsloth-b12651</span>); mainline llama-server cannot load
          Inkling-2-Mini. {status(missingServer)}
        </li>
        <li>
          <span className="font-mono text-[11.5px]">llama_cpp.model_path</span>: the{' '}
          <span className="font-mono text-[11.5px]">{LLAMA_CPP_MODEL_FILE}</span> model file. {status(missingModel)}
        </li>
        <li>
          <span className="font-mono text-[11.5px]">cudart64_*.dll</span> and{' '}
          <span className="font-mono text-[11.5px]">cublas64_*.dll</span> beside llama-server.exe — the b12651 portable
          build ships without them.
        </li>
      </ul>
      <p className="mt-2 text-ink-2">
        The two paths come from the fields below, or from{' '}
        <span className="font-mono text-[11.5px]">JARVIS_LLAMA_SERVER_PATH</span> and{' '}
        <span className="font-mono text-[11.5px]">JARVIS_LLAMA_MODEL_PATH</span> when a field is left blank.
      </p>
      <p className="mt-1.5 text-ink-2">
        Either point the llama.cpp base URL at an already-running llama.cpp server and leave both paths blank, or choose
        an already-configured Inference backend (Ollama, OpenRouter or Claude Code CLI).
      </p>
    </div>
  );
}
