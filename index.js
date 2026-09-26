import 'expo-dev-client';
import { registerRootComponent } from 'expo';
import App from './App';

// registerRootComponent works in Expo Go and development builds and also
// preserves the standard React Native entry point for native builds.
registerRootComponent(App);
