import { createGovernor } from './src/governor';
import { createConscience } from './src';
import { createSandbox, createHoldout, replayDecisions, proposeExperiment, runExperiment } from './src/autoconscience';
import type { ExperimentAgent, ExperimentResult, ReplayResult, RegisteredExperiment } from './src/autoconscience';
const governor = createGovernor({ budgets: { perCycle: 1, perAgent: 5, perOrganisation: 10 } });
const conscience = createConscience({ governor, masker: (text) => text });
const binding = { governor, organisationId: 'org' };
const agent: ExperimentAgent = async (input, tools) => { await tools.write(input); return input; };
async function verifyExperimentTypes() {
  const sandbox = await createSandbox({ ...binding, tools: { write: { kind: 'write', execute: () => 1 }, read: { kind: 'read', response: null } } });
  void await sandbox.tools.write({ value: 1 });
  void (await sandbox.getJournal())[0]?.kind;
  const holdout = await createHoldout({ ...binding, cases: [{ id: 'h', input: 3, expected: 3 }] });
  // @ts-expect-error Protected content has no public field.
  void holdout.cases;
  const experiment: RegisteredExperiment = await proposeExperiment({ ...binding, hypothesis: 'identity', agent,
    holdout, metrics: [{ name: 'accuracy', kind: 'exact_match' }], thresholds: { accuracy: 0.9 },
    protocol: { development: [{ id: 'd', input: 1, expected: 1 }], validation: [{ id: 'v', input: 2, expected: 2 }], minimumSample: 30 } });
  // @ts-expect-error Preregistered thresholds cannot change.
  experiment.thresholds.accuracy = 0;
  // @ts-expect-error Preregistered cases are deeply immutable.
  experiment.protocol.development[0].expected = 0;
  const result: ExperimentResult = await runExperiment({ ...binding, experiment });
  void result.stages.holdout.metrics.accuracy.interval;
  // @ts-expect-error Individual final inputs/intentions are not returned.
  void result.stages.holdout.journal;
  const replay: ReplayResult = await replayDecisions({ ...binding, conscience, decisionIds: ['d'], asOf: '2026-10-09', proposal: { agent }, snapshots: {
    snapshot: { organisationId: binding.organisationId, at: '2026-10-01', recordedAt: '2026-10-01', data: null }
  } });
  void replay.provesProgress;
  // @ts-expect-error Choose exactly one selection mode.
  void replayDecisions({ ...binding, conscience, decisionIds: ['d'], window: { from: '2026-10-01', to: '2026-10-02' }, asOf: '2026-10-09', proposal: { agent } });
  // @ts-expect-error Arbitrary objects are not authentic registration handles.
  void runExperiment({ ...binding, experiment: { id: 'forged' } });
}
void verifyExperimentTypes;
