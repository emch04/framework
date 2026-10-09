import { createElement } from 'react';
import App, { AstratraDashboardApp, AuthProvider, useAuth, Layout, Notice, DashboardScreen, LoginScreen, SettingsScreen, UsersScreen, FeedbackBar, FEEDBACK_COMMENT_MAX, FEEDBACK_LABELS, FEEDBACK_REASONS, resolveFeedbackLabels, feedbackPress, clampComment, buildFeedbackPayload, feedbackReasonOptions, ApiError, apiFetch } from './src';
import { apiFetch as subpathFetch, ApiError as SubpathError } from '@astratra/saas-kit-ui/api';
createElement(App); createElement(AstratraDashboardApp); createElement(AuthProvider, {}, 'content');
const auth = useAuth(); auth.login({ email: 'user@example.test', password: 'example' }); auth.logout(); auth.request<{ count: number }>('/dashboard');
createElement(Layout, { activeView: 'users', onNavigate: view => void view });
createElement(Notice, { tone: 'error' }, 'message');
createElement(DashboardScreen); createElement(LoginScreen, { onLoggedIn() {} }); createElement(SettingsScreen); createElement(UsersScreen);
createElement(FeedbackBar, { value: 'down', defaultOpen: true, style: { color: 'red' }, reasons: ['custom'], labels: { reasons: { custom: 'Custom' } }, onSubmit: payload => void payload.rating, onRemove() {}, haptics() {} });
const labels = resolveFeedbackLabels({ locale: 'fr', labels: { counter: (used, max) => `${used}/${max}` } });
feedbackReasonOptions({ labels, reasons: FEEDBACK_REASONS, selected: null });
const action = feedbackPress(null, 'up'); if (action.type === 'submit') { const up: 'up' = action.payload.rating; void up; }
clampComment('text', FEEDBACK_COMMENT_MAX); buildFeedbackPayload({ rating: 'down', reason: 'other', comment: 'text' }); void FEEDBACK_LABELS.fr.up;
apiFetch<{ id: string }>('/users', { token: null }); subpathFetch('/users'); new ApiError('error', { status: 401 }); new SubpathError('error');
// @ts-expect-error Unsupported rating.
createElement(FeedbackBar, { value: 'sideways' });
// @ts-expect-error A payload requires a valid rating.
buildFeedbackPayload({ rating: 'invalid' });
// @ts-expect-error Navigation accepts known screens.
createElement(Layout, { activeView: 'unknown', onNavigate() {} });
