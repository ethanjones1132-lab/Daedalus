import type { HarnessRunResult } from "./controller";
import type { EngineControl } from "./engine";
import { catalogue, type EngineState, type HarnessModule, type RunBudget } from "./module";

type CatalogueEntry = Pick<HarnessModule, "id" | "version" | "description" | "good_for" | "bad_for" | "params_schema" | "limits">;

export interface ChildHandle {
  id: string;
  status(): "running" | "done" | "failed";
  result(): HarnessRunResult | null;
}

export interface HarnessScriptApi {
  list(): CatalogueEntry[];
  describe(id: string): CatalogueEntry | null;
  state(): EngineState;
  attach(id: string, params: unknown, reason: string): void;
  switch(id: string, params: unknown, reason: string): void;
  spawn(options: { role: string; task: string; scope: string[]; harness?: string; params?: unknown; budget: Partial<RunBudget> }): ChildHandle;
  request(options: { task: string; why_existing_dont_fit: string; desired_behaviour: string; examples?: string[] }): { request_id: string };
}

export function createHarnessScriptApi(control: Pick<EngineControl, "state" | "attach" | "switch">): HarnessScriptApi {
  const list = (): CatalogueEntry[] => catalogue().map(({ id, version, description, good_for, bad_for, params_schema, limits }) => ({
    id, version, description, good_for, bad_for, params_schema, limits,
  }));
  return {
    list,
    describe: (id) => list().find((entry) => entry.id === id) ?? null,
    state: () => control.state(),
    attach: (id, params, reason) => control.attach(id, params, reason),
    switch: (id, params, reason) => control.switch(id, params, reason),
    spawn: () => { throw new Error("spawn not available yet"); },
    request: () => { throw new Error("request not available yet"); },
  };
}
