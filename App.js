/**
 * NatakaRemote - physical-remote inspired frontend.
 * The ADB connection layer remains unchanged; this file only reshapes the UI
 * and adds common Android TV key controls.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  StatusBar,
  ScrollView,
  PanResponder,
} from 'react-native';

import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { AdbClient, ConnectionState } from './adb/AdbClient';

const SAVED_IPS_KEY = 'natakaremote:savedIps';
const MAX_SAVED_IPS = 5;
const SWIPE_THRESHOLD = 28; // px of travel before a drag counts as a swipe

// Package names for common streaming apps. These target standard Android
// (most X96-style boxes), not the Android TV variants - edit here if your
// box uses different builds (e.g. com.google.android.youtube.tv on real
// Android TV / Google TV devices).
const APPS = [
  { label: 'Netflix', pkg: 'com.netflix.mediaclient' },
  { label: 'YouTube', pkg: 'com.google.android.youtube' },
  { label: 'Prime Video', pkg: 'com.amazon.amazonvideo.livingroom' },
  { label: 'Disney+', pkg: 'com.disney.disneyplus' },
  { label: 'Spotify', pkg: 'com.spotify.music' },
];

const KEYCODE = {
  POWER: 26,
  UP: 19,
  DOWN: 20,
  LEFT: 21,
  RIGHT: 22,
  ENTER: 23,
  BACK: 4,
  HOME: 3,
  MENU: 82,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  VOLUME_MUTE: 164,
  DELETE: 67,
  DIGIT_0: 7,
  DIGIT_1: 8,
  DIGIT_2: 9,
  DIGIT_3: 10,
  DIGIT_4: 11,
  DIGIT_5: 12,
  DIGIT_6: 13,
  DIGIT_7: 14,
  DIGIT_8: 15,
  DIGIT_9: 16,
};

const STATE_LABEL = {
  [ConnectionState.DISCONNECTED]: 'Disconnected',
  [ConnectionState.CONNECTING]: 'Connecting…',
  [ConnectionState.AUTH_REQUIRED]: 'Approve on TV…',
  [ConnectionState.CONNECTED]: 'Connected',
  [ConnectionState.ERROR]: 'Connection error',
};

const STATE_COLOR = {
  [ConnectionState.DISCONNECTED]: '#777b83',
  [ConnectionState.CONNECTING]: '#d99b2b',
  [ConnectionState.AUTH_REQUIRED]: '#d99b2b',
  [ConnectionState.CONNECTED]: '#4caf50',
  [ConnectionState.ERROR]: '#d94b4b',
};

export default function App() {
  const [ip, setIp] = useState('');
  const [state, setState] = useState(ConnectionState.DISCONNECTED);
  const [busy, setBusy] = useState(false);
  const [savedIps, setSavedIps] = useState([]);
  const clientRef = useRef(null);

  useEffect(() => {
    clientRef.current = new AdbClient({ onStateChange: setState });
    return () => clientRef.current?.disconnect();
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(SAVED_IPS_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setSavedIps(parsed);
      })
      .catch(() => {
        // Corrupt/missing storage - just start with an empty list.
      });
  }, []);

  const rememberIp = useCallback((value) => {
    setSavedIps((prev) => {
      const next = [value, ...prev.filter((item) => item !== value)].slice(
        0,
        MAX_SAVED_IPS
      );
      AsyncStorage.setItem(SAVED_IPS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const forgetIp = useCallback((value) => {
    setSavedIps((prev) => {
      const next = prev.filter((item) => item !== value);
      AsyncStorage.setItem(SAVED_IPS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const isConnected = state === ConnectionState.CONNECTED;
  const isConnecting =
    state === ConnectionState.CONNECTING ||
    state === ConnectionState.AUTH_REQUIRED;

  const handleConnectToggle = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;

    if (isConnected || isConnecting) {
      client.disconnect();
      return;
    }

    const trimmed = ip.trim();
    if (!trimmed) {
      Alert.alert('IP address required', 'Enter the TV box local IP address, e.g. 192.168.1.42');
      return;
    }

    try {
      await client.connect(trimmed);
      rememberIp(trimmed);
    } catch (err) {
      Alert.alert('Couldn’t connect', err.message || String(err));
    }
  }, [ip, isConnected, isConnecting, rememberIp]);

  const sendKey = useCallback(async (keycode) => {
    const client = clientRef.current;
    if (!client || !isConnected) return;
    setBusy(true);
    try {
      await client.sendKeyEvent(keycode);
    } catch (err) {
      console.warn('ADB command failed:', err.message || err);
    } finally {
      setBusy(false);
    }
  }, [isConnected]);

  const launchApp = useCallback(async (pkg) => {
    const client = clientRef.current;
    if (!client || !isConnected) return;
    setBusy(true);
    try {
      await client.runShellCommand(
        `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`
      );
    } catch (err) {
      console.warn('App launch failed:', err.message || err);
      Alert.alert('Couldn’t launch app', 'Is it installed on this device?');
    } finally {
      setBusy(false);
    }
  }, [isConnected]);

  // Swipe-to-navigate on the D-pad: drag in any direction to move the
  // on-screen focus without hunting for the small arrow buttons.
  // PanResponder is created once (useRef), so it reaches the latest
  // isConnected/sendKey through this ref rather than a stale closure.
  const liveRef = useRef({ isConnected, sendKey });
  liveRef.current = { isConnected, sendKey };
  const dpadPanResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) =>
        Math.abs(gesture.dx) > 10 || Math.abs(gesture.dy) > 10,
      onPanResponderRelease: (_evt, gesture) => {
        const { isConnected: connected, sendKey: send } = liveRef.current;
        if (!connected) return;
        const { dx, dy } = gesture;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_THRESHOLD) return;
        if (Math.abs(dx) > Math.abs(dy)) {
          send(dx > 0 ? KEYCODE.RIGHT : KEYCODE.LEFT);
        } else {
          send(dy > 0 ? KEYCODE.DOWN : KEYCODE.UP);
        }
      },
    })
  ).current;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#08090b" />

      <View style={styles.header}>
        <View style={styles.brandWrap}>
          <Text style={styles.brand}>NATAKA</Text>
          <View style={[styles.connectionDot, { backgroundColor: STATE_COLOR[state] }]} />
        </View>
        <Text style={styles.stateText}>{STATE_LABEL[state]}</Text>
      </View>

      <View style={styles.connectionRow}>
        <TextInput
          style={styles.ipInput}
          placeholder="TV IP address"
          placeholderTextColor="#777b83"
          value={ip}
          onChangeText={setIp}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="decimal-pad"
          editable={!isConnected && !isConnecting}
        />
        <TouchableOpacity
          style={[styles.connectButton, isConnected && styles.disconnectButton]}
          onPress={handleConnectToggle}
          activeOpacity={0.75}
        >
          {isConnecting ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.connectText}>{isConnected ? 'OFF' : 'CONNECT'}</Text>
          )}
        </TouchableOpacity>
      </View>

      {savedIps.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {savedIps.map((savedIp) => (
            <TouchableOpacity
              key={savedIp}
              style={[styles.chip, savedIp === ip && styles.chipActive]}
              onPress={() => setIp(savedIp)}
              onLongPress={() => forgetIp(savedIp)}
              disabled={isConnected || isConnecting}
              activeOpacity={0.7}
            >
              <Text style={styles.chipText}>{savedIp}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <ScrollView
        contentContainerStyle={styles.page}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.remote}>
          {/* Power / TV control */}
          <View style={styles.powerRow}>
            <RemoteButton
              label="⏻"
              kind="redPower"
              disabled={!isConnected}
              onPress={() => sendKey(KEYCODE.POWER)}
            />
            <View style={styles.remoteTopLabel}>
              <View style={styles.labelLine} />
              <Text style={styles.tvControl}>TV CONTROL</Text>
              <View style={styles.labelLine} />
            </View>
            <RemoteButton
              label="⏻"
              kind="whitePower"
              disabled={!isConnected}
              onPress={() => sendKey(KEYCODE.POWER)}
            />
          </View>

          <View style={styles.smallRow}>
            <SmallButton label="SET" />
            <SmallButton label="TV IN" />
            <SmallButton label="VOL−" onPress={() => sendKey(KEYCODE.VOLUME_DOWN)} disabled={!isConnected} />
            <SmallButton label="VOL+" onPress={() => sendKey(KEYCODE.VOLUME_UP)} disabled={!isConnected} />
          </View>

          <View style={styles.colorRow}>
            <SmallButton label="SETUP" tone="red" />
            <SmallButton label="APP" tone="green" onPress={() => sendKey(KEYCODE.HOME)} disabled={!isConnected} />
            <SmallButton label="VOL−" tone="yellow" onPress={() => sendKey(KEYCODE.VOLUME_DOWN)} disabled={!isConnected} />
            <SmallButton label="VOL+" tone="blue" onPress={() => sendKey(KEYCODE.VOLUME_UP)} disabled={!isConnected} />
          </View>

          {/* Home / Back */}
          <View style={styles.iconRow}>
            <RoundButton icon="⌂" onPress={() => sendKey(KEYCODE.HOME)} disabled={!isConnected} />
            <RoundButton icon="↩" onPress={() => sendKey(KEYCODE.BACK)} disabled={!isConnected} />
          </View>

          {/* D-pad - also responds to swipes, not just the arrow buttons */}
          <View style={styles.dpadOuter} {...dpadPanResponder.panHandlers}>
            <RoundButton icon="▲" size="dpad" onPress={() => sendKey(KEYCODE.UP)} disabled={!isConnected} />
            <View style={styles.dpadMiddle}>
              <RoundButton icon="◀" size="dpad" onPress={() => sendKey(KEYCODE.LEFT)} disabled={!isConnected} />
              <TouchableOpacity
                style={[styles.okButton, !isConnected && styles.disabled]}
                disabled={!isConnected}
                onPress={() => sendKey(KEYCODE.ENTER)}
                activeOpacity={0.7}
              >
                <Text style={styles.okText}>OK</Text>
              </TouchableOpacity>
              <RoundButton icon="▶" size="dpad" onPress={() => sendKey(KEYCODE.RIGHT)} disabled={!isConnected} />
            </View>
            <RoundButton icon="▼" size="dpad" onPress={() => sendKey(KEYCODE.DOWN)} disabled={!isConnected} />
          </View>

          {/* Menu / sleep-like key */}
          <View style={styles.iconRowLower}>
            <RoundButton icon="☰" onPress={() => sendKey(KEYCODE.MENU)} disabled={!isConnected} />
            <RoundButton icon="⏻" onPress={() => sendKey(KEYCODE.POWER)} disabled={!isConnected} />
          </View>

          {/* Number pad */}
          <View style={styles.numberGrid}>
            {[1,2,3,4,5,6,7,8,9].map((n) => (
              <NumberButton key={n} label={String(n)} onPress={() => sendKey(KEYCODE[`DIGIT_${n}`])} disabled={!isConnected} />
            ))}
            <NumberButton label="⌁" onPress={() => sendKey(KEYCODE.VOLUME_MUTE)} disabled={!isConnected} />
            <NumberButton label="0" onPress={() => sendKey(KEYCODE.DIGIT_0)} disabled={!isConnected} />
            <NumberButton label="⌫" onPress={() => sendKey(KEYCODE.DELETE)} disabled={!isConnected} />
          </View>

          <View style={styles.appsSection}>
            <Text style={styles.appsLabel}>APPS</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.appsRow}
            >
              {APPS.map((app) => (
                <TouchableOpacity
                  key={app.pkg}
                  style={[styles.appButton, !isConnected && styles.disabled]}
                  onPress={() => launchApp(app.pkg)}
                  disabled={!isConnected}
                  activeOpacity={0.7}
                >
                  <Text style={styles.appButtonText}>{app.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          <View style={styles.bottomInset} />
          {busy && <ActivityIndicator style={styles.busy} color="#b9bcc2" size="small" />}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function RemoteButton({ label, kind, onPress, disabled }) {
  return (
    <TouchableOpacity
      style={[styles.remoteButton, styles[kind], disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <Text style={[styles.remoteButtonText, kind === 'redPower' && styles.redPowerText]}>{label}</Text>
    </TouchableOpacity>
  );
}

function SmallButton({ label, tone, onPress, disabled = false }) {
  return (
    <TouchableOpacity
      style={[styles.smallButton, tone && styles[`tone_${tone}`], disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled || !onPress}
      activeOpacity={0.7}
    >
      <Text style={styles.smallButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

function RoundButton({ icon, onPress, disabled, size }) {
  return (
    <TouchableOpacity
      style={[styles.roundButton, size === 'dpad' && styles.dpadArrow, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <Text style={[styles.roundIcon, size === 'dpad' && styles.dpadIcon]}>{icon}</Text>
    </TouchableOpacity>
  );
}

function NumberButton({ label, onPress, disabled }) {
  return (
    <TouchableOpacity
      style={[styles.numberButton, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <Text style={styles.numberText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#08090b' },
  header: {
    height: 44,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brandWrap: { flexDirection: 'row', alignItems: 'center' },
  brand: { color: '#e7e8ea', fontWeight: '800', letterSpacing: 2.5, fontSize: 15 },
  connectionDot: { width: 7, height: 7, borderRadius: 4, marginLeft: 8 },
  stateText: { color: '#858990', fontSize: 11 },
  connectionRow: { flexDirection: 'row', paddingHorizontal: 14, marginBottom: 4 },
  ipInput: {
    flex: 1,
    height: 36,
    color: '#e5e6e8',
    backgroundColor: '#14161a',
    borderWidth: 1,
    borderColor: '#292c31',
    borderRadius: 7,
    paddingHorizontal: 11,
    fontSize: 12,
  },
  connectButton: {
    height: 36,
    minWidth: 82,
    marginLeft: 7,
    borderRadius: 7,
    backgroundColor: '#24272d',
    borderWidth: 1,
    borderColor: '#3b3f46',
    alignItems: 'center',
    justifyContent: 'center',
  },
  disconnectButton: { backgroundColor: '#552326', borderColor: '#743036' },
  connectText: { color: '#e7e8ea', fontSize: 10, fontWeight: '800', letterSpacing: 0.7 },
  page: { alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14 },
  remote: {
    width: '100%',
    maxWidth: 380,
    minHeight: 760,
    borderRadius: 25,
    backgroundColor: '#1a1c20',
    borderWidth: 1,
    borderColor: '#383b40',
    paddingHorizontal: 17,
    paddingTop: 13,
    paddingBottom: 15,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  powerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  remoteButton: { alignItems: 'center', justifyContent: 'center' },
  redPower: { width: 46, height: 31, borderRadius: 15, backgroundColor: '#bd3036' },
  whitePower: { width: 46, height: 31, borderRadius: 9, backgroundColor: '#5e6268', borderWidth: 1, borderColor: '#d3d5d8' },
  remoteButtonText: { color: '#f1f2f3', fontSize: 16 },
  redPowerText: { color: '#fff', fontSize: 17 },
  remoteTopLabel: { flexDirection: 'row', alignItems: 'center', flex: 1, justifyContent: 'center', marginHorizontal: 5 },
  labelLine: { height: 1, backgroundColor: '#777a7f', flex: 1 },
  tvControl: { color: '#d4d6d8', fontSize: 9, letterSpacing: 0.5, marginHorizontal: 5, fontWeight: '700' },
  smallRow: { flexDirection: 'row', marginTop: 9, borderWidth: 1, borderColor: '#aeb2b8', borderRadius: 8, overflow: 'hidden' },
  smallButton: { height: 31, flex: 1, minWidth: 0, backgroundColor: '#15171a', alignItems: 'center', justifyContent: 'center', borderRightWidth: 1, borderRightColor: '#303338' },
  smallButtonText: { color: '#f0f1f2', fontSize: 10, fontWeight: '700' },
  colorRow: { flexDirection: 'row', marginTop: 8 },
  tone_red: { backgroundColor: '#b93438', borderRadius: 6, marginHorizontal: 2 },
  tone_green: { backgroundColor: '#3e9d63', borderRadius: 6, marginHorizontal: 2 },
  tone_yellow: { backgroundColor: '#9c8a32', borderRadius: 6, marginHorizontal: 2 },
  tone_blue: { backgroundColor: '#315eae', borderRadius: 6, marginHorizontal: 2 },
  iconRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 13 },
  roundButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#111317', borderWidth: 1, borderColor: '#34373c', alignItems: 'center', justifyContent: 'center' },
  roundIcon: { color: '#f1f2f3', fontSize: 18, fontWeight: '700' },
  dpadOuter: { alignItems: 'center', marginTop: 2 },
  dpadMiddle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  dpadArrow: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#15171b', borderColor: '#070809' },
  dpadIcon: { fontSize: 14 },
  okButton: { width: 88, height: 88, borderRadius: 44, backgroundColor: '#0c0e11', borderWidth: 2, borderColor: '#30343a', alignItems: 'center', justifyContent: 'center', marginHorizontal: 5 },
  okText: { color: '#e9eaec', fontSize: 21, fontWeight: '400' },
  iconRowLower: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 7 },
  numberGrid: { marginTop: 10, flexDirection: 'row', flexWrap: 'wrap' },
  numberButton: { height: 31, backgroundColor: '#0e1013', borderRadius: 13, borderWidth: 1, borderColor: '#24272c', alignItems: 'center', justifyContent: 'center', marginBottom: 5, width: '31%', marginHorizontal: '1.16%' },
  numberText: { color: '#e8e9eb', fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.48 },
  chipRow: { paddingHorizontal: 14, paddingBottom: 8, gap: 7 },
  chip: {
    height: 28,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: '#14161a',
    borderWidth: 1,
    borderColor: '#292c31',
    justifyContent: 'center',
    marginRight: 7,
  },
  chipActive: { backgroundColor: '#24303a', borderColor: '#3d5568' },
  chipText: { color: '#c7c9cd', fontSize: 11, fontWeight: '600' },
  appsSection: { marginTop: 14, width: '100%' },
  appsLabel: {
    color: '#777a7f',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 6,
  },
  appsRow: { gap: 7 },
  appButton: {
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#15171a',
    borderWidth: 1,
    borderColor: '#292c31',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 7,
  },
  appButtonText: { color: '#e5e6e8', fontSize: 11, fontWeight: '700' },
  bottomInset: { height: 35, marginHorizontal: 28, marginTop: 4, backgroundColor: '#15171a', borderRadius: 8, borderWidth: 1, borderColor: '#202328' },
  busy: { position: 'absolute', right: 13, top: 12 },
});
