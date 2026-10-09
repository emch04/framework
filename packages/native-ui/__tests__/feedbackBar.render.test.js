/** The feedback bar mounted over the react-native mocks (test/rn.js). */
require('../test/dom');

jest.mock('react-native', () => require('../test/rn').reactNative(), { virtual: true });
jest.mock('react-native-reanimated', () => require('../test/rn').reanimated(), { virtual: true });
jest.mock('expo-glass-effect', () => require('../test/rn').glassEffect(), { virtual: true });
jest.mock('expo-blur', () => require('../test/rn').blur(), { virtual: true });
jest.mock('expo-linear-gradient', () => require('../test/rn').linearGradient(), { virtual: true });
const mockTicks = [];
jest.mock('expo-haptics', () => ({ selectionAsync: () => { mockTicks.push('selection'); return Promise.resolve(); } }), { virtual: true });

globalThis.__platform = 'ios';
globalThis.__liquidGlass = true;

const React = require('react');
const { render, fireEvent, cleanup } = require('@testing-library/react');
const ui = require('../src');

const h = React.createElement;
afterEach(() => {
  cleanup();
  mockTicks.length = 0;
});

describe('FeedbackBar', () => {
  test('two buttons with the app\'s words; the chosen one is marked', () => {
    const { getByLabelText } = render(h(ui.FeedbackBar, { value: 'up' }));
    expect(getByLabelText('Good answer').getAttribute('aria-selected')).toBe('true');
    expect(getByLabelText('Bad answer').getAttribute('aria-selected')).toBe('false');
  });

  test('French locale and overridden labels', () => {
    const { getByLabelText } = render(h(ui.FeedbackBar, { locale: 'fr', labels: { up: 'Super' } }));
    expect(getByLabelText('Super')).toBeTruthy();
    expect(getByLabelText('Mauvaise réponse')).toBeTruthy();
  });

  test('up is sent at once; pressing the chosen thumb withdraws', () => {
    const onSubmit = jest.fn();
    const onRemove = jest.fn();
    const { getByLabelText, rerender } = render(h(ui.FeedbackBar, { onSubmit, onRemove }));
    fireEvent.click(getByLabelText('Good answer'));
    expect(onSubmit).toHaveBeenCalledWith({ rating: 'up' });
    rerender(h(ui.FeedbackBar, { value: 'up', onSubmit, onRemove }));
    fireEvent.click(getByLabelText('Good answer'));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('down opens the sheet; reason and comment are sent together; nothing before', () => {
    const onSubmit = jest.fn();
    const { getByLabelText, queryByText, getByText, getByPlaceholderText, container } = render(h(ui.FeedbackBar, { onSubmit, testID: 'fb' }));
    expect(queryByText('What went wrong?')).toBeNull();
    fireEvent.click(getByLabelText('Bad answer'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getByText('What went wrong?')).toBeTruthy();
    fireEvent.click(getByLabelText('Too long'));
    expect(getByLabelText('Too long').getAttribute('aria-selected')).toBe('true');
    fireEvent.change(getByPlaceholderText('Tell us more (optional)'), { target: { value: '  Keep it short  ' } });
    fireEvent.click(container.querySelector('[data-testid="fb-send"]'));
    expect(onSubmit).toHaveBeenCalledWith({ rating: 'down', reason: 'too_long', comment: 'Keep it short' });
    expect(queryByText('What went wrong?')).toBeNull();
  });

  test('the reason and the comment are optional; cancel sends nothing and forgets', () => {
    const onSubmit = jest.fn();
    const { getByLabelText, container, queryByText } = render(h(ui.FeedbackBar, { onSubmit, testID: 'fb' }));
    fireEvent.click(getByLabelText('Bad answer'));
    fireEvent.click(container.querySelector('[data-testid="fb-send"]'));
    expect(onSubmit).toHaveBeenLastCalledWith({ rating: 'down' });
    fireEvent.click(getByLabelText('Bad answer'));
    fireEvent.click(getByLabelText('Unsafe'));
    fireEvent.click(container.querySelector('[data-testid="fb-cancel"]'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(queryByText('What went wrong?')).toBeNull();
    fireEvent.click(getByLabelText('Bad answer'));
    expect(getByLabelText('Unsafe').getAttribute('aria-selected')).toBe('false');
  });

  test('the app can offer its own reasons with its own words', () => {
    const onSubmit = jest.fn();
    const { getByLabelText, container } = render(h(ui.FeedbackBar, { onSubmit, testID: 'fb', reasons: ['slow'], labels: { reasons: { slow: 'Too slow' } } }));
    fireEvent.click(getByLabelText('Bad answer'));
    fireEvent.click(getByLabelText('Too slow'));
    fireEvent.click(container.querySelector('[data-testid="fb-send"]'));
    expect(onSubmit).toHaveBeenCalledWith({ rating: 'down', reason: 'slow' });
  });

  test('disabled: no press does anything', () => {
    const onSubmit = jest.fn();
    const { getByLabelText, queryByText } = render(h(ui.FeedbackBar, { onSubmit, disabled: true }));
    fireEvent.click(getByLabelText('Good answer'));
    fireEvent.click(getByLabelText('Bad answer'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(queryByText('What went wrong?')).toBeNull();
    expect(getByLabelText('Good answer').getAttribute('aria-disabled')).toBe('true');
  });

  test('a haptic tick when expo-haptics is there; silent when told so; the app\'s own tick wins', () => {
    const { getByLabelText, rerender } = render(h(ui.FeedbackBar, { onSubmit: () => {} }));
    fireEvent.click(getByLabelText('Good answer'));
    expect(mockTicks).toEqual(['selection']);
    rerender(h(ui.FeedbackBar, { onSubmit: () => {}, haptics: false }));
    fireEvent.click(getByLabelText('Good answer'));
    expect(mockTicks).toEqual(['selection']);
    const own = jest.fn();
    rerender(h(ui.FeedbackBar, { onSubmit: () => {}, haptics: own }));
    fireEvent.click(getByLabelText('Good answer'));
    expect(own).toHaveBeenCalledTimes(1);
    expect(mockTicks).toEqual(['selection']);
  });

  test('the group is a labelled toolbar', () => {
    const { container } = render(h(ui.FeedbackBar, { locale: 'fr', testID: 'fb' }));
    const bar = container.querySelector('[data-testid="fb"]');
    expect(bar.getAttribute('role')).toBe('toolbar');
    expect(bar.getAttribute('aria-label')).toBe('Évaluer cette réponse');
  });
});
