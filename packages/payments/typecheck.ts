import {
  createCheckoutFlow,
  readCheckoutUrl,
  readEntityId,
  readRenewalDate,
  DUPLICATE,
  HANDLED,
  IGNORED,
  UNRELATED,
  createMemoryEventLog,
  createWebhookExemption,
  createWebhookHandler,
  duplicate,
  handled,
  isOutcome,
  unrelated
} from './src';
import type {
  CheckoutFlow,
  PlanAction,
  PollDecision,
  EventLog,
  HandlerContext,
  Outcome,
  OutcomeStatus,
  RequestLike,
  ResponseLike,
  WebhookHandler,
  WebhookResponse
} from './src';

interface StripeEvent {
  id: string;
  type: string;
  account?: string;
  data: { object: Record<string, unknown> };
}

const log: EventLog = createMemoryEventLog({ limit: 5000 });

const webhook: WebhookHandler = createWebhookHandler<StripeEvent>({
  verify: ({ payload, headers, secret }) => {
    void [payload, headers, secret];
    return { id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } };
  },
  secret: async () => 'whsec_from_the_vault',
  events: {
    'checkout.session.completed': async (event, context: HandlerContext) => {
      if (event.account !== 'acct_expected') return context.unrelated('another connected account');
      await context.sideEffect('confirmation email', async () => 'sent');
      return context.handled();
    },
    'checkout.session.expired': (event) => {
      void event.id;
    }
  },
  eventLog: log,
  eventId: (event) => event.id,
  logger: { info: () => {}, warn: () => {}, error: () => {} }
});

const isWebhook = createWebhookExemption({ prefix: '/api/payments/', suffix: '/webhook' });

const statuses: OutcomeStatus[] = [HANDLED, UNRELATED, DUPLICATE, IGNORED];
const outcomes: Outcome[] = [handled('done'), unrelated('not ours'), duplicate('seen')];
const checked: boolean = isOutcome(outcomes[0]);

async function exercise(req: RequestLike, res: ResponseLike): Promise<void> {
  const response: WebhookResponse = await webhook.receive({ payload: Buffer.from('{}'), headers: {} });
  await webhook.middleware(req, res);
  await webhook.sideEffect('audit', () => 1);
  void [response.status, isWebhook(req), isWebhook('/api/payments/x/webhook'), statuses, checked];
}

void exercise;

/* ─────────────────── The client side of paying ─────────────────── */

const flow: CheckoutFlow = createCheckoutFlow({
  notPurchasable: ['trial'],
  defaultPlan: 'trial',
  maxAttempts: 24,
  intervalMs: 5000,
  confirms: { stripe: () => true, cinetpay: (payload) => (payload as { success?: boolean })?.success === true }
});

const action: PlanAction = flow.planAction('pro', 'starter');
const decision: PollDecision = flow.nextPoll({ confirmed: false, attempts: 3 });
const payUrl: string | null = readCheckoutUrl({ checkoutUrl: 'https://pay' });
const accountId: string = readEntityId({ _id: 'acct-1' });
const renewal: Date | null = readRenewalDate(1790000000);

void [action, decision, payUrl, accountId, renewal, flow.canPay(accountId), flow.isConfirmed('stripe', {}), flow.intervalMs];
