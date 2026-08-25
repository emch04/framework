import {
  InvitationError,
  createAccessMatrix,
  createInvitations,
  createMemoryInvitationStore,
  createTenantScope,
  createCommissionSchedule,
  createFeatureGuard,
  createPlanCatalog,
  createStatusGuard,
  except
} from './src';
import type {
  AccessMatrix,
  Invitation,
  InvitationStore,
  Invitations,
  CommissionResult,
  CommissionSchedule,
  NextFunction,
  PlanCatalog,
  RequestHandler,
  RequestLike,
  ResolvedAccount,
  ResolvedStatus,
  Responder,
  ResponseLike
} from './src';

const catalog: PlanCatalog = createPlanCatalog({
  plans: {
    free: ['dashboard'],
    starter: ['dashboard', 'reports'],
    pro: ['dashboard', 'reports', 'analytics']
  },
  labels: { free: 'Free', starter: 'Starter', pro: 'Pro' },
  upgradePath: { free: 'starter', starter: 'pro' },
  fallbackPlan: 'free'
});

const included: boolean = catalog.hasFeature('starter', 'reports', ['analytics']);
const features: string[] = catalog.featuresOf('pro');
const nextPlan: string | null = catalog.upgradeFrom('free');
const everyFeature: string[] = catalog.allFeatures();

const respond: Responder = (res, payload) => res.status(payload.status).json({ message: payload.message });

const guard = createFeatureGuard({
  catalog,
  resolveAccount: async (req): Promise<ResolvedAccount | null> => {
    const user = req.user as { plan?: string } | undefined;
    return user?.plan ? { plan: user.plan, overrides: [] } : null;
  },
  isExempt: (req) => (req.user as { role?: string } | undefined)?.role === 'support',
  isEnabled: async (feature) => feature !== 'analytics',
  respond,
  onError: 'deny',
  onErrorLog: (error, feature) => void [error, feature]
});

const reportsGuard: RequestHandler = guard('reports');

const suspension: RequestHandler = createStatusGuard({
  resolveStatus: async (): Promise<ResolvedStatus | null> => ({ status: 'suspended', name: 'Acme', reason: 'unpaid' }),
  blockedStatuses: ['suspended', 'closed'],
  isExempt: () => false,
  message: ({ status }) => `blocked: ${status}`,
  respond,
  onError: 'allow'
});

const schedule: CommissionSchedule = createCommissionSchedule({
  defaultRate: 0.01,
  rates: { enterprise: 0.005 },
  round: Math.round
});
const split: CommissionResult = schedule.commissionOn(10_000, 'enterprise');
const rate: number = schedule.rateFor('pro');

const matrix: AccessMatrix = createAccessMatrix({
  screens: {
    dashboard: ['owner', 'member'],
    finance: except(['owner', 'member', 'guest'], 'guest')
  },
  superRoles: ['support']
});

const canOpen: boolean = matrix.canAccess('finance', 'owner');
const menu: string[] = matrix.screensFor('member');
const roles: string[] = matrix.rolesFor('finance');

function exercise(req: RequestLike, res: ResponseLike, next: NextFunction): void {
  void reportsGuard(req, res, next);
  void suspension(req, res, next);
  void [included, features, nextPlan, everyFeature, split, rate, canOpen, menu, roles, matrix.allRoles(), catalog.knows('pro')];
}

void exercise;

interface ScopedUser { role: string; school?: string }

const tenantScope = createTenantScope<ScopedUser>({
  field: 'school',
  globalRoles: ['hero_admin'],
  tenantOf: (user) => user?.school,
  impossibleValue: '000000000000000000000000',
  onMissingTenant: (user) => void user
});

const scopedQuery: Record<string, unknown> = tenantScope.scope({ role: 'director', school: 's9' }, { status: 'active' });
const allowed: boolean = tenantScope.canAccess({ role: 'director', school: 's9' }, 's9');
void [scopedQuery, allowed, tenantScope.field];

/* ────────────────────────── Invitations ────────────────────────── */

interface InvitedAccount { email: string; role: string }
interface RegistrationForm { name: string; password: string }

const invitationStore: InvitationStore = createMemoryInvitationStore();

const invitations: Invitations<InvitedAccount, RegistrationForm> =
  createInvitations<InvitedAccount, RegistrationForm>({
    store: invitationStore,
    roles: ['teacher', 'secretary'],
    createAccount: async (invitation: Invitation, form: RegistrationForm) => ({
      email: invitation.email || 'x@y.cd',
      role: invitation.role,
      name: form.name
    } as InvitedAccount & { name: string }),
    ttlMs: 24 * 60 * 60 * 1000,
    buildUrl: (token) => `https://app/register?token=${token}`,
    deliver: async ({ url, token }) => void [url, token],
    now: () => Date.now(),
    logger: { warn: () => {}, info: () => {} }
  });

async function exerciseInvitations(): Promise<void> {
  const { invitation, token, url } = await invitations.invite({
    email: 'marie@ecole.cd', role: 'teacher', invitedBy: 'director-1', tenant: 's9'
  });
  const preview = await invitations.verify(token);
  const { account } = await invitations.accept(token, { name: 'Marie', password: 'x' });
  await invitations.revoke(invitation.id, { revokedBy: 'director-1' }).catch((e) => {
    if (e instanceof InvitationError) void e.statusCode;
  });
  const open = await invitations.list({ status: 'pending' });
  void [preview.role, account.email, url, open.length, invitations.roles, invitations.hashToken('t')];
}

void exerciseInvitations;
