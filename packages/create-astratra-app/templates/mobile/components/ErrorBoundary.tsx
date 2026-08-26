/**
 * One broken screen must not take the app with it.
 *
 * Without a boundary, a render error on a detail screen unmounts everything
 * and leaves a white rectangle — indistinguishable, to the person holding the
 * phone, from a crash.
 */
import { Component, type ReactNode } from 'react';
import { Text, View } from 'react-native';

type State = { failed: boolean };

export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return this.props.fallback ?? (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text>Something went wrong on this screen.</Text>
      </View>
    );
  }
}
