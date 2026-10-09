import type { CreateGuardsOptions, GuardEvent, GuardModels, Guards } from '../index';

export interface FakeModelsRules {
  /** Texts `entities` finds. */
  names?: string[];
  injectionScore?(text: string): number;
  moderate?(text: string): { unsafe: number; categories: Record<string, number> };
  entails?(premise: string, claim: string): boolean;
  /** Endpoints that answer a failure. */
  down?: string[];
}
export interface FakeModels extends Required<GuardModels> {
  calls: Array<{ endpoint: string; size: number }>;
  setDown(endpoint: string, down?: boolean): void;
}
export function createFakeModels(rules?: FakeModelsRules): FakeModels;

export interface EventRecorder {
  (event: GuardEvent): void;
  events: GuardEvent[];
  last(): GuardEvent | undefined;
  decisions(guard?: string): string[];
}
export function createEventRecorder(): EventRecorder;
export function createMockGuards(options?: Omit<CreateGuardsOptions, 'models'> & { rules?: FakeModelsRules; models?: GuardModels }): {
  guards: Guards;
  models: GuardModels;
  events: GuardEvent[];
  recorder: EventRecorder;
};
