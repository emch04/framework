import { createFlagProvider, createMemorySource } from './src';
import type { FlagRules, Resolution } from './src';

const rules: FlagRules = { flags: {
  oracle: { type: 'boolean', default: false, value: true, rollout: 10, target: { country: 'FR' } },
  mobileOracle: { type: 'boolean', default: false, value: true, target: { all: [
    { platform: 'ios' }, { version: { '>=': '1.1.9' } },
    { any: [{ plan: 'pro' }, { number: { attribute: 'studentCount', between: [1, 500] } }] }
  ] } }
} };
const provider = createFlagProvider({ source: createMemorySource(rules) });
async function example(): Promise<void> {
  const result: Resolution<boolean> = await provider.resolveBoolean('oracle', false, { targetingKey: 'school-42', attributes: { country: 'FR' } });
  void result.reason;
}
void example;
