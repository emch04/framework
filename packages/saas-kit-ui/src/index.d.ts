import type { CSSProperties, ReactElement, ReactNode } from 'react';
import type { ApiFetchOptions } from './lib/api';
export { ApiError, apiFetch } from './lib/api';
export type { ApiFetchOptions } from './lib/api';
export default function AstratraDashboardApp(props?: { adminRoles?: readonly string[] }): ReactElement;
export { AstratraDashboardApp };
export interface AuthUser { email?: string; role?: string; [key: string]: unknown }
export interface AuthValue {
  isAuthenticated: boolean;
  token: string | null;
  user: AuthUser | null;
  login(input: { email: string; password: string }): Promise<AuthUser>;
  logout(): void;
  request<T = unknown>(path: string, options?: ApiFetchOptions): Promise<T>;
}
export function AuthProvider(props: { children?: ReactNode }): ReactElement;
export function useAuth(): AuthValue;
export type DashboardView = 'dashboard' | 'users' | 'settings';
export function Layout(props: { activeView: DashboardView; onNavigate: (view: DashboardView) => void; children?: ReactNode; /** Screens to offer; default: those the signed-in role allows. */ views?: readonly DashboardView[] }): ReactElement;
export const DEFAULT_ADMIN_ROLES: readonly string[];
export const DEFAULT_OWNER_ROLES: readonly string[];
/** null: any signed-in person; 'admin': one of the admin roles. */
export const VIEW_ACCESS: Readonly<Record<DashboardView, null | 'admin'>>;
export function canSeeView(view: string, user: AuthUser | null | undefined, options?: { adminRoles?: readonly string[] }): boolean;
export function visibleViews(user: AuthUser | null | undefined, options?: { adminRoles?: readonly string[] }): DashboardView[];
export function assignableRoles(user: AuthUser | null | undefined, options?: { adminRoles?: readonly string[]; ownerRoles?: readonly string[]; roles?: readonly string[] }): string[];
export function Notice(props: { tone?: 'neutral' | 'error' | 'success'; children?: ReactNode }): ReactElement | null;
export function DashboardScreen(): ReactElement;
export function LoginScreen(props: { onLoggedIn: () => void }): ReactElement;
export function SettingsScreen(): ReactElement;
export function UsersScreen(): ReactElement;
export type FeedbackRating = 'up' | 'down';
export type FeedbackReason = 'inaccurate' | 'incomplete' | 'off_topic' | 'wrong_source' | 'too_long' | 'unsafe' | 'other';
export interface FeedbackPayload { rating: FeedbackRating; reason?: string; comment?: string }
export interface FeedbackLabels {
  group: string; up: string; down: string; sheetTitle: string;
  commentLabel: string; commentPlaceholder: string; submit: string; cancel: string;
  reasons: Readonly<Record<string, string>>;
  counter: (used: number, max: number) => string;
}
export type FeedbackLabelOverrides = Partial<FeedbackLabels>;
export const FEEDBACK_COMMENT_MAX: 500;
export const FEEDBACK_REASONS: readonly FeedbackReason[];
export const FEEDBACK_LABELS: Readonly<{ en: Readonly<FeedbackLabels>; fr: Readonly<FeedbackLabels> }>;
export function resolveFeedbackLabels(options?: { locale?: string; labels?: FeedbackLabelOverrides }): FeedbackLabels;
export type FeedbackAction = { type: 'none' } | { type: 'remove' } | { type: 'ask' } | { type: 'submit'; payload: { rating: 'up' } };
export function feedbackPress(value: FeedbackRating | null | undefined, rating: unknown): FeedbackAction;
export function clampComment(text: unknown, max?: number): string;
export function buildFeedbackPayload(options: { rating: FeedbackRating; reason?: string | null; comment?: string; reasons?: readonly string[]; maxComment?: number }): FeedbackPayload;
export function feedbackReasonOptions(options: { reasons?: readonly string[]; labels: FeedbackLabels; selected?: string | null }): { id: string; label: string; selected: boolean }[];
export interface FeedbackBarProps {
  value?: FeedbackRating | null;
  onSubmit?: (payload: FeedbackPayload) => void;
  onRemove?: () => void;
  disabled?: boolean;
  reasons?: readonly string[];
  maxComment?: number;
  labels?: FeedbackLabelOverrides;
  locale?: string;
  icons?: { up?: ReactNode; down?: ReactNode };
  haptics?: false | (() => void);
  defaultOpen?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
}
export function FeedbackBar(props: FeedbackBarProps): ReactElement;
