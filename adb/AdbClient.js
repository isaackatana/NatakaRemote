/**
 * AdbClient.js
 *
 * Drives a single wireless-ADB connection end to end:
 *   TCP connect -> CNXN -> AUTH handshake -> CNXN (authed) -> OPEN/WRTE/CLSE
 *
 * This is a small EventEmitter-style class rather than a React hook so it
 * has no dependency on React lifecycle; App.js wraps it with useState/
 * useEffect. Keeping the protocol state machine outside of React makes it
 * much easier to reason about (and unit test) independently of re-renders.
 */

import TcpSocket from 'react-native-tcp-socket';
import {
  A_CNXN,
  A_AUTH,
  A_OPEN,
  A_OKAY,
  A_CLSE,
  A_WRTE,
  A_VERSION,
  MAX_PAYLOAD,
  AUTH_TOKEN,
  AUTH_SIGNATURE,
  AUTH_RSAPUBLICKEY,
  encodeMessage,
  encodeCString,
  decodeCString,
  MessageReader,
} from './adbProtocol';
import { getOrCreateAdbKeyPair, signAdbToken } from './adbCrypto';

export const ConnectionState = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  AUTH_REQUIRED: 'AUTH_REQUIRED', // waiting on the on-device "Allow?" prompt
  CONNECTED: 'CONNECTED',
  ERROR: 'ERROR',
});

const ADB_PORT = 5555;
const CONNECT_TIMEOUT_MS = 8000;
const COMMAND_TIMEOUT_MS = 6000;

export class AdbClient {
  constructor({ onStateChange } = {}) {
    this.onStateChange = onStateChange || (() => {});
    this.socket = null;
    this.reader = null;
    this.state = ConnectionState.DISCONNECTED;
    this.keyPair = null;
    this.nextLocalId = 1;
    this.streams = new Map(); // localId -> { resolve, reject, chunks, timer }
    this.triedSignature = false;
    this.connectTimer = null;
  }

  _setState(state, extra) {
    this.state = state;
    this.onStateChange(state, extra);
  }

  /**
   * Connect and complete the full auth handshake. Resolves once the
   * device sends back an authenticated CNXN (state -> CONNECTED).
   * Rejects on timeout, refused connection, or protocol error.
   */
  async connect(host) {
    this.disconnect(); // clean slate
    this._setState(ConnectionState.CONNECTING);

    this.keyPair = await getOrCreateAdbKeyPair();
    this.triedSignature = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(this.connectTimer);
        this._setState(ConnectionState.ERROR, err.message);
        this.disconnect();
        reject(err);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(this.connectTimer);
        resolve();
      };

      this.connectTimer = setTimeout(
        () => fail(new Error('Connection timed out')),
        CONNECT_TIMEOUT_MS
      );

      try {
        this.socket = TcpSocket.createConnection(
          { host, port: ADB_PORT, tls: false },
          () => {
            // TCP connected - kick off the ADB handshake with CNXN.
            const banner = encodeCString('host::features=shell_v2');
            this.socket.write(
              Buffer.from(
                encodeMessage(A_CNXN, A_VERSION, MAX_PAYLOAD, banner)
              )
            );
          }
        );
      } catch (err) {
        fail(err);
        return;
      }

      this.reader = new MessageReader((msg) => {
        try {
          this._handleMessage(msg, { succeed, fail });
        } catch (err) {
          fail(err);
        }
      });

      this.socket.on('data', (data) => {
        // react-native-tcp-socket delivers a Buffer/Uint8Array-like.
        this.reader.push(new Uint8Array(data));
      });

      this.socket.on('error', (err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });

      this.socket.on('close', () => {
        if (this.state !== ConnectionState.DISCONNECTED) {
          this._setState(ConnectionState.DISCONNECTED);
        }
        fail(new Error('Connection closed'));
      });
    });
  }

  _handleMessage(msg, { succeed, fail }) {
    const { command, arg0, arg1, data } = msg;

    switch (command) {
      case A_CNXN: {
        // Device accepted us - fully authenticated and ready.
        this._setState(ConnectionState.CONNECTED);
        succeed();
        break;
      }

      case A_AUTH: {
        if (arg0 !== AUTH_TOKEN) break; // ignore anything unexpected
        const token = data; // 20 random bytes

        if (!this.triedSignature) {
          // First attempt: sign the token with our existing private key.
          // If the device already trusts this key (from a previous
          // session), it will accept this immediately with no on-screen
          // prompt at all.
          this.triedSignature = true;
          const signature = signAdbToken(token, this.keyPair.privateKey);
          this.socket.write(
            Buffer.from(encodeMessage(A_AUTH, AUTH_SIGNATURE, 0, signature))
          );
        } else {
          // The device rejected our signature, meaning it doesn't
          // recognize this key yet. Send the public key instead - this
          // is what triggers the "Allow USB debugging from this
          // computer?" dialog on the TV screen. The user MUST accept it
          // there; there is no way around that prompt, by design.
          this._setState(ConnectionState.AUTH_REQUIRED);
          const pubKeyPayload = encodeCString(
            this.keyPair.publicKeyBlob.replace(/\n$/, '')
          );
          this.socket.write(
            Buffer.from(
              encodeMessage(A_AUTH, AUTH_RSAPUBLICKEY, 0, pubKeyPayload)
            )
          );
        }
        break;
      }

      case A_OKAY: {
        const stream = this.streams.get(arg1);
        if (stream) stream.remoteId = arg0;
        break;
      }

      case A_WRTE: {
        const stream = this.streams.get(arg1);
        if (stream) {
          stream.chunks.push(decodeCString(data));
          // Ack the write so the device keeps sending / doesn't stall.
          this.socket.write(
            Buffer.from(encodeMessage(A_OKAY, arg1, arg0))
          );
        }
        break;
      }

      case A_CLSE: {
        const stream = this.streams.get(arg1);
        if (stream) {
          clearTimeout(stream.timer);
          this.streams.delete(arg1);
          stream.resolve(stream.chunks.join(''));
        }
        break;
      }

      default:
        // Unknown/irrelevant command - ignore rather than fail hard.
        break;
    }
  }

  /**
   * Run a one-shot `adb shell <command>` equivalent over the existing
   * connection and resolve with its stdout/stderr text.
   */
  runShellCommand(command) {
    if (this.state !== ConnectionState.CONNECTED) {
      return Promise.reject(new Error('Not connected'));
    }

    const localId = this.nextLocalId++;
    // encodeCString appends the NUL terminator ADB's OPEN payload expects.
    const openPayload = encodeCString(`shell:${command}`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.streams.delete(localId);
        reject(new Error(`Command timed out: ${command}`));
      }, COMMAND_TIMEOUT_MS);

      this.streams.set(localId, { resolve, reject, chunks: [], timer });

      try {
        this.socket.write(
          Buffer.from(encodeMessage(A_OPEN, localId, 0, openPayload))
        );
      } catch (err) {
        clearTimeout(timer);
        this.streams.delete(localId);
        reject(err);
      }
    });
  }

  /** Convenience wrapper for `input keyevent <code>`. */
  sendKeyEvent(keycode) {
    return this.runShellCommand(`input keyevent ${keycode}`);
  }

  disconnect() {
    clearTimeout(this.connectTimer);
    for (const stream of this.streams.values()) {
      clearTimeout(stream.timer);
    }
    this.streams.clear();
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (e) {
        // socket already gone - fine
      }
      this.socket = null;
    }
    this.reader = null;
    this.nextLocalId = 1;
    this._setState(ConnectionState.DISCONNECTED);
  }
}
