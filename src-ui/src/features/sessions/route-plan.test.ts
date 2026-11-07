import { describe, expect, it } from 'vitest';
import {
  formatAnsweredBy,
  formatAttemptLine,
  formatTurnReason,
  parseRouteAttempt,
  parseRoutePlan,
  routePlanFromAttempts,
} from './route-plan';

const attempt = (over: Record<string, unknown> = {}) => ({
  stage: 'synthesizer', provider: 'llama_cpp', model: 'Qwen3.6', choice: 'configured',
  outcome: 'success', answered: true, cloud: false, duration_ms: 23_400, first_token_ms: 23_100, ...over,
});

describe('session route plan', () => {
  it('names the model that answered and says the turn stayed local', () => {
    const plan = parseRoutePlan({
      answered_by: { stage: 'synthesizer', provider: 'llama_cpp', model: 'Qwen3.6', cloud: false },
      left_machine: false,
      attempts: [attempt()],
    })!;
    expect(formatAnsweredBy(plan)).toContain('Answered by');
    expect(formatAnsweredBy(plan)).toContain('Qwen3.6');
    expect(formatAnsweredBy(plan)).toContain('stayed on this PC');
  });

  it('discloses a cloud hop and counts fallbacks even when local answered', () => {
    const plan = parseRoutePlan({
      answered_by: { stage: 'synthesizer', provider: 'llama_cpp', model: 'Qwen3.6', cloud: false },
      attempts: [
        attempt({ provider: 'opencode_zen', model: 'deepseek-v4-flash-free', cloud: true, answered: false, outcome: 'http_error', choice: 'pool', error: 'HTTP 400' }),
        attempt({ choice: 'fallback', fallback_reason: 'http_error' }),
      ],
    })!;
    expect(plan.leftMachine).toBe(true);
    expect(formatAnsweredBy(plan)).toContain('used a cloud provider');
    expect(formatAnsweredBy(plan)).toContain('1 fallback');
    expect(formatAttemptLine(plan.attempts[0])).toContain('(cloud)');
    expect(formatAttemptLine(plan.attempts[0])).toContain('HTTP 400');
    expect(formatAttemptLine(plan.attempts[1])).toContain('after http error');
  });

  it('says plainly when no model answered', () => {
    const plan = routePlanFromAttempts([parseRouteAttempt(attempt({ answered: false, outcome: 'timeout' }))!]);
    expect(formatAnsweredBy(plan)).toMatch(/^No model answered · 1 attempt/);
  });

  it('rejects incomplete frames and tolerates an older server with no route', () => {
    expect(parseRouteAttempt({ stage: 'synthesizer', provider: '', model: 'x' })).toBeNull();
    expect(parseRoutePlan(undefined)).toBeNull();
  });

  it('formats one trace row with timing and the choice', () => {
    const line = formatAttemptLine(parseRouteAttempt(attempt({ choice: 'pool' }))!);
    expect(line).toContain('answered');
    expect(line).toContain('23.4 s');
    expect(line).toContain('first token 23.1 s');
    expect(line).toContain('chosen by pool');
  });

  it('puts completion reasons in plain words', () => {
    expect(formatTurnReason('task_plan_open')).toBe('the task plan still has open steps');
    expect(formatTurnReason('something_new')).toBe('something new');
    expect(formatTurnReason(undefined)).toBeUndefined();
  });
});
