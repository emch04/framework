import { DEFAULT_NEVER_EXPORT, createArchiveBuilder, createClosureChecklist, createScrubber } from './src';
import type { Archive, Checklist, CloseDecision, ClosureChecklist, Scrubber } from './src';

const checklist: ClosureChecklist = createClosureChecklist([
  { id: 'deliberations', label: 'Délibérations', blocking: true },
  { id: 'unpaid_fees', label: 'Impayés', blocking: false }
]);

const built: Checklist = checklist.build({ deliberations: 0, unpaid_fees: 12 });
const decision: CloseDecision = checklist.canCloseWith(built, ['unpaid_fees']);

const scrubber: Scrubber = createScrubber({ alsoNever: ['activationCode'] });

interface Scope { yearId: string; school: string }

const builder = createArchiveBuilder<Scope>({
  sections: [
    { name: 'students', read: async ({ school }) => [{ school, fullName: 'Jean' }] },
    { name: 'results', read: async ({ yearId }) => [{ yearId, score: 14 }] }
  ],
  scrubber,
  logger: { error: () => {} }
});

async function exercise(): Promise<void> {
  const archive: Archive = await builder.build({ yearId: 'y1', school: 's9' });
  void [
    archive.complete, archive.counts, archive.failed,
    built.canClose, decision.ok, checklist.checks, builder.sections,
    scrubber.scrub({ password: 'x' }), scrubber.banned, DEFAULT_NEVER_EXPORT
  ];
}

void exercise;
