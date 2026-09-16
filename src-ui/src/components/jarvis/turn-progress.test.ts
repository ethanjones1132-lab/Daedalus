import { describe, expect, it } from 'vitest';
import { buildTurnProgress } from './chat-state';

describe('buildTurnProgress', () => {
  it.each(['completed', 'failed', 'timed_out', 'cancelled', 'partial'])('does not describe a %s stage as still running', (status) => {
    const progress = buildTurnProgress({
      isStreaming: true,
      pipelineStage: '',
      agentSteps: [{ stage: 'executor', text: status }],
    });
    expect(progress?.text).toBe(`Last stage update: executor — ${status.replaceAll('_', ' ')}. Waiting for the next update.`);
  });

  it('does not invent stage progress before telemetry arrives', () => {
    expect(buildTurnProgress({ isStreaming: true, pipelineStage: '', agentSteps: [] })?.text)
      .toBe('Waiting for Session turn progress.');
  });

  it('shows the reported active stage, ahead of historical terminal entries', () => {
    expect(buildTurnProgress({ isStreaming: true, pipelineStage: 'reviewer', agentSteps: [{ stage: 'executor', text: 'completed' }] })?.text)
      .toBe('Running stage: reviewer.');
  });

  it('prioritizes approval over a running stage', () => {
    expect(buildTurnProgress({ isStreaming: true, pipelineStage: 'executor', agentSteps: [], approvalName: 'write_file' })?.text)
      .toBe('Waiting for approval to run write_file.');
  });

  it('labels activity as an observation, not proof that a stage is running', () => {
    expect(buildTurnProgress({ isStreaming: true, pipelineStage: '', agentSteps: [{ stage: 'executor', text: 'reading files' }] })?.text)
      .toBe('Last activity: executor. Waiting for the next update.');
  });

  it('shows response text receipt without inventing a stage', () => {
    expect(buildTurnProgress({ isStreaming: true, pipelineStage: '', agentSteps: [], hasResponseText: true })?.text)
      .toBe('Receiving response text.');
  });

  it('preserves elapsed terminal status instead of claiming response work', () => {
    expect(buildTurnProgress({ isStreaming: true, pipelineStage: '', agentSteps: [{ stage: 'executor', text: 'failed in 1.2s' }], hasResponseText: true })?.text)
      .toBe('Last stage update: executor — failed in 1.2s. Waiting for the next update.');
  });

  it('hides in-flight progress after the Session turn ends', () => {
    expect(buildTurnProgress({ isStreaming: false, pipelineStage: 'executor', agentSteps: [] })).toBeNull();
  });
});
