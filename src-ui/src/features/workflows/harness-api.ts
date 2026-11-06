import { bunOrigin } from '../../lib/bun-origin';

// Wire types live here so src-ui tsc does not compile server-jarvis (node:crypto, bun:sqlite).
export type HarnessPurpose = 'bug_fix' | 'feature' | 'generic_audit' | 'release_prep';
export type HarnessTemplateFamily = 'typescript_node' | 'rust_cargo' | 'generic_audit' | 'release_prep';
export interface HarnessGuides {
  rules: string[];
  brief_template: string;
  skills: string[];
  references: string[];
  banned_defaults: string[];
}
export interface HarnessSensor {
  id: string;
  kind: 'command' | 'unavailable';
  command_id?: string;
  args: string[];
  timeout_ms: number;
  zero_threshold: number;
  failure_message: string;
  required: boolean;
  baseline?: number;
}
export interface HarnessManifest {
  schema_version: 1;
  id: string;
  project_root: string;
  project_kind: string;
  purpose: HarnessPurpose;
  template_family: HarnessTemplateFamily;
  guides: HarnessGuides;
  maker_agent_id: string;
  checker: { enabled: boolean; agent_id: string; rubric: string };
  sensors: HarnessSensor[];
  loop: { max_rounds: number; abort_on_no_progress: boolean };
  approval: { required_for_new_commands: boolean };
}
export interface HarnessSensorResult {
  id: string;
  run_id: string;
  round_id: string;
  sensor_id: string;
  status: 'passed' | 'failed' | 'not_applicable';
  counter?: number | null;
  exit_code?: number | null;
  stdout: string;
  stdout_truncated: boolean;
  stderr: string;
  stderr_truncated: boolean;
  created_at: string;
}
export interface HarnessRun {
  id: string;
  project_root: string;
  manifest_id: string;
  manifest_hash: string;
  status: string;
  created_at: string;
  rounds: Array<{ id: string; run_id: string; round_number: number; counter_vector: Record<string, number | null | 'not_applicable'>; created_at: string; sensor_results: HarnessSensorResult[] }>;
  events: Array<{ id: string; run_id: string; event_type: string; payload: unknown; created_at: string }>;
}

export interface SavedHarnessManifest {
  manifest: HarnessManifest;
  revision: number;
  manifest_hash: string;
}
export interface HarnessTemplateSummary {
  id: string;
  project_kind: string;
  purpose: HarnessPurpose;
  template_family: HarnessTemplateFamily;
  guides: HarnessManifest['guides'];
  maker_agent_id: string;
  checker: HarnessManifest['checker'];
  sensors: HarnessManifest['sensors'];
  loop: HarnessManifest['loop'];
  approval: HarnessManifest['approval'];
}

export type HarnessApiErrorCode = 'stale_revision' | 'http_error';
export class HarnessApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: HarnessApiErrorCode) {
    super(message);
    this.name = 'HarnessApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await globalThis.fetch(`${await bunOrigin()}${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
      ? payload.error : `Harness request failed (${response.status})`;
    throw new HarnessApiError(detail, response.status, response.status === 409 ? 'stale_revision' : 'http_error');
  }
  return payload as T;
}

function rootQuery(projectRoot: string): string {
  return `project_root=${encodeURIComponent(projectRoot)}`;
}

export const harnessApi = {
  async listTemplates(): Promise<HarnessTemplateSummary[]> {
    return (await request<{ templates: HarnessTemplateSummary[] }>('/harness/templates')).templates;
  },
  async resolveProjectRoot(root: string): Promise<string> {
    return (await request<{ project_root: string }>('/harness/projects/resolve', {
      method: 'POST', body: JSON.stringify({ root }),
    })).project_root;
  },
  async listManifests(projectRoot: string): Promise<SavedHarnessManifest[]> {
    return (await request<{ manifests: SavedHarnessManifest[] }>(`/harness/manifests?${rootQuery(projectRoot)}`)).manifests;
  },
  async getManifest(projectRoot: string, id: string): Promise<SavedHarnessManifest> {
    return request<SavedHarnessManifest>(`/harness/manifests/${encodeURIComponent(id)}?${rootQuery(projectRoot)}`);
  },
  async createManifest(manifest: HarnessManifest): Promise<SavedHarnessManifest> {
    return request('/harness/manifests', { method: 'POST', body: JSON.stringify({ manifest, expected_revision: 0 }) });
  },
  async updateManifest(manifest: HarnessManifest, expectedRevision: number): Promise<SavedHarnessManifest> {
    return request(`/harness/manifests/${encodeURIComponent(manifest.id)}`, {
      method: 'PUT', body: JSON.stringify({ manifest, expected_revision: expectedRevision }),
    });
  },
  async createFromTemplate(templateId: string, projectRoot: string): Promise<SavedHarnessManifest> {
    return request('/harness/manifests/from-template', {
      method: 'POST', body: JSON.stringify({ template_id: templateId, project_root: projectRoot, expected_revision: 0 }),
    });
  },
  async listRuns(projectRoot: string): Promise<HarnessRun[]> {
    return (await request<{ runs: HarnessRun[] }>(`/harness/runs?${rootQuery(projectRoot)}`)).runs;
  },
  async getRun(projectRoot: string, id: string): Promise<HarnessRun> {
    return (await request<{ run: HarnessRun }>(`/harness/runs/${encodeURIComponent(id)}?${rootQuery(projectRoot)}`)).run;
  },
  async previewGuides(input: { project_root: string; manifest_id?: string; manifest?: HarnessManifest; role?: 'maker' | 'checker'; brief_values?: Record<string, string> }): Promise<{
    guides_rendered: true; text: string; truncated: boolean; provenance: string[];
  }> {
    return request('/harness/guides/preview', { method: 'POST', body: JSON.stringify(input) });
  },
};


