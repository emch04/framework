/**
 * The screens behind the session, kept behind it.
 *
 * Signing out used to replace the top screen with the sign-in page and leave
 * the whole stack behind it: a few taps on Back returned to the dashboard —
 * signed out, with the previous person's data still on screen. `replace`, not
 * `push`, and the decision waits for the session to finish restoring.
 */
import { useEffect } from 'react';
import { useRouter, useSegments } from 'expo-router';
import { guard } from '../features/routes';
import { useAuth } from '../context/AuthContext';

export function SessionGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    const redirect = guard.shouldRedirectToLogin({
      isLoading: loading,
      isAuthenticated: Boolean(user),
      route: segments as readonly string[]
    });
    if (redirect) router.replace(guard.loginRoute as never);
  }, [user, loading, segments, router]);

  return <>{children}</>;
}
