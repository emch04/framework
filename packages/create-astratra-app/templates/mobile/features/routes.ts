/**
 * What is reachable without a session, and where a notification may lead.
 *
 * Both lists are written the same way, and it is the important part: they name
 * what is ALLOWED. A list of protected screens silently admits every screen
 * added later and forgotten in the list.
 */
import { createRouteGuard } from '@astratra/client';
import { createNotificationRouter } from '@astratra/native';

export const guard = createRouteGuard({
  publicSegments: ['home', 'login', 'forgot-password', 'reset-password', 'onboarding'],
  loginRoute: '/login'
});

/** Add a rule per screen a notification may open. Anything else lands on the list. */
export const notificationRouter = createNotificationRouter({
  fallback: '/notifications',
  routes: [
    { pattern: /^\/dashboard$/, allow: (role) => Boolean(role) },
    { pattern: /^\/settings$/, allow: (role) => Boolean(role) }
  ]
});
