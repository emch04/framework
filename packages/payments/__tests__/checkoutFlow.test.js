const {
  DEFAULT_CONFIRMATION_INTERVAL_MS,
  DEFAULT_MAX_CONFIRMATION_ATTEMPTS,
  createCheckoutFlow,
  readCheckoutUrl,
  readEntityId,
  readRenewalDate
} = require('../src');

describe('readCheckoutUrl', () => {
  test('finds the payment page whichever gateway named it', () => {
    expect(readCheckoutUrl({ checkoutUrl: 'https://pay/1' })).toBe('https://pay/1');
    expect(readCheckoutUrl({ paymentUrl: 'https://pay/2' })).toBe('https://pay/2');
    expect(readCheckoutUrl({ url: 'https://pay/3' })).toBe('https://pay/3');
  });

  test('extra field names can be declared for another gateway', () => {
    expect(readCheckoutUrl({ redirect: 'https://pay/4' }, ['redirect'])).toBe('https://pay/4');
  });

  test('nothing usable answers null, so the screen can say so', () => {
    expect(readCheckoutUrl({ checkoutUrl: '' })).toBeNull();
    expect(readCheckoutUrl({})).toBeNull();
    expect(readCheckoutUrl(null)).toBeNull();
    expect(readCheckoutUrl('https://pay')).toBeNull();
  });
});

describe('readEntityId', () => {
  test('the same id whether the field arrived raw or populated', () => {
    expect(readEntityId('acct-1')).toBe('acct-1');
    expect(readEntityId({ _id: 'acct-1' })).toBe('acct-1');
    expect(readEntityId({ id: 'acct-1' })).toBe('acct-1');
  });

  test('anything else is empty — better than sending "[object Object]"', () => {
    expect(readEntityId(null)).toBe('');
    expect(readEntityId({})).toBe('');
    expect(readEntityId(42)).toBe('');
  });
});

describe('readRenewalDate', () => {
  test('turns a gateway epoch in seconds into a date', () => {
    expect(readRenewalDate(1790000000)?.toISOString()).toBe(new Date(1790000000000).toISOString());
  });

  test('absent or nonsensical values are no date at all', () => {
    expect(readRenewalDate(0)).toBeNull();
    expect(readRenewalDate(-1)).toBeNull();
    expect(readRenewalDate('soon')).toBeNull();
    expect(readRenewalDate(undefined)).toBeNull();
  });
});

describe('createCheckoutFlow — what a plan button may do', () => {
  const flow = createCheckoutFlow({ notPurchasable: ['trial'] });

  test('the plan already held is the current one, never a purchase', () => {
    expect(flow.planAction('starter', 'starter')).toBe('current');
  });

  test('a plan that is granted rather than sold cannot be bought', () => {
    expect(flow.planAction('trial', 'starter')).toBe('locked');
    expect(flow.isSelectable('trial', 'starter')).toBe(false);
  });

  test('anything else is choosable', () => {
    expect(flow.planAction('pro', 'starter')).toBe('choose');
    expect(flow.isSelectable('pro', 'starter')).toBe(true);
  });

  test('with no current plan, the default one counts as current', () => {
    const withDefault = createCheckoutFlow({ notPurchasable: ['trial'], defaultPlan: 'trial' });

    expect(withDefault.planAction('trial', null)).toBe('current');
    expect(withDefault.planAction('pro', null)).toBe('choose');
  });

  test('an account with nothing to bill cannot pay — and is TOLD so', () => {
    expect(flow.canPay('acct-1')).toBe(true);
    expect(flow.canPay('')).toBe(false);
    expect(flow.canPay(null)).toBe(false);
  });
});

describe('createCheckoutFlow — confirming the payment', () => {
  const flow = createCheckoutFlow();

  test('a confirmed payment stops the loop', () => {
    expect(flow.nextPoll({ confirmed: true, attempts: 0 })).toBe('confirmed');
  });

  test('it retries until the cap, then hands over to the webhook', () => {
    expect(flow.nextPoll({ confirmed: false, attempts: 1 })).toBe('retry');
    expect(flow.nextPoll({ confirmed: false, attempts: DEFAULT_MAX_CONFIRMATION_ATTEMPTS })).toBe('pending');
  });

  test('"pending" is not "failed" — the money may well have moved', () => {
    const decision = flow.nextPoll({ confirmed: false, attempts: 999 });

    expect(decision).toBe('pending');
    expect(decision).not.toBe('failed');
  });

  test('the cap and the interval can be tuned per gateway', () => {
    const quick = createCheckoutFlow({ maxAttempts: 2, intervalMs: 1000 });

    expect(quick.intervalMs).toBe(1000);
    expect(quick.nextPoll({ confirmed: false, attempts: 2 })).toBe('pending');
    expect(flow.intervalMs).toBe(DEFAULT_CONFIRMATION_INTERVAL_MS);
  });

  test('confirmation is read per gateway, because they do not answer alike', () => {
    const gateways = createCheckoutFlow({
      confirms: {
        /* One only ever returns a subscription when it is live… */
        stripe: () => true,
        /* …the other reports a boolean on its verification call. */
        cinetpay: (payload) => payload?.success === true
      }
    });

    expect(gateways.isConfirmed('stripe', { anything: true })).toBe(true);
    expect(gateways.isConfirmed('cinetpay', { success: true })).toBe(true);
    expect(gateways.isConfirmed('cinetpay', { success: false })).toBe(false);
    expect(gateways.isConfirmed('cinetpay', null)).toBe(false);
  });

  test('AN UNDECLARED GATEWAY IS NOT CONFIRMED — silence must never grant access', () => {
    const gateways = createCheckoutFlow({ confirms: { stripe: () => true } });

    expect(gateways.isConfirmed('mystery', { success: true })).toBe(false);
  });

  test('a confirmation reader that throws answers not-confirmed', () => {
    const gateways = createCheckoutFlow({ confirms: { boom: () => { throw new Error('bad payload'); } } });

    expect(gateways.isConfirmed('boom', {})).toBe(false);
  });
});
