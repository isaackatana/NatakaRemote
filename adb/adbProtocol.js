/**
 * adbProtocol.js
 *
 * Low-level ADB wire protocol implementation.
 *
 * Every ADB message is a 24-byte header followed by an optional data
 * payload. All integers are unsigned 32-bit, little-endian.
 *
 *   struct message {
 *     uint32_t command;        // command identifier constant
 *     uint32_t arg0;           // first argument
 *     uint32_t arg1;           // second argument
 *     uint32_t data_length;    // length of payload, 0 if none
 *     uint32_t data_check;     // checksum of payload (sum of bytes)
 *     uint32_t magic;          // command ^ 0xFFFFFFFF, sanity check
 *   };
 *
 * These command constants are the public, well-documented values used by
 * every ADB client (including Google's own `adb` binary) - see AOSP
 * system/core/adb/protocol.txt for the canonical reference.
 */

export const A_SYNC = 0x434e5953;
export const A_CNXN = 0x4e584e43;
export const A_OPEN = 0x4e45504f;
export const A_OKAY = 0x59414b4f;
export const A_CLSE = 0x45534c43;
export const A_WRTE = 0x45545257;
export const A_AUTH = 0x48545541;

export const AUTH_TOKEN = 1;
export const AUTH_SIGNATURE = 2;
export const AUTH_RSAPUBLICKEY = 3;

// Protocol version + max payload size we advertise in CNXN.
// 0x01000000 is the "classic" version that still uses the additive
// checksum below (later versions negotiate checksum-less framing, but
// plain `adb tcpip 5555` targets like the X96 almost always speak this
// version), 4096 is a conservative, universally-accepted max payload.
export const A_VERSION = 0x01000000;
export const MAX_PAYLOAD = 4096;

const HEADER_LENGTH = 24;

/** Classic ADB checksum: sum of all payload bytes, truncated to 32 bits. */
export function checksum(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum = (sum + data[i]) >>> 0;
  }
  return sum >>> 0;
}

function writeUInt32LE(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function readUInt32LE(buf, offset) {
  return (
    (buf[offset] |
      (buf[offset + 1] << 8) |
      (buf[offset + 2] << 16) |
      (buf[offset + 3] << 24)) >>>
    0
  );
}

/**
 * Encode a full ADB message (header + payload) as a Uint8Array ready to
 * write to the TCP socket.
 *
 * @param {number} command  one of the A_* constants
 * @param {number} arg0
 * @param {number} arg1
 * @param {Uint8Array} [data]  optional payload (already includes any
 *                             trailing NUL the caller wants)
 */
export function encodeMessage(command, arg0, arg1, data = new Uint8Array(0)) {
  const header = new Uint8Array(HEADER_LENGTH);
  writeUInt32LE(header, 0, command);
  writeUInt32LE(header, 4, arg0);
  writeUInt32LE(header, 8, arg1);
  writeUInt32LE(header, 12, data.length);
  writeUInt32LE(header, 16, checksum(data));
  writeUInt32LE(header, 20, (command ^ 0xffffffff) >>> 0);

  const out = new Uint8Array(HEADER_LENGTH + data.length);
  out.set(header, 0);
  out.set(data, HEADER_LENGTH);
  return out;
}

/** UTF-8 string -> Uint8Array, with a trailing NUL byte (ADB convention). */
export function encodeCString(str) {
  const body = Array.from(unescape(encodeURIComponent(str))).map((c) =>
    c.charCodeAt(0)
  );
  body.push(0);
  return new Uint8Array(body);
}

/** Uint8Array -> UTF-8 string (drops a single trailing NUL if present). */
export function decodeCString(bytes) {
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0) end -= 1;
  let s = '';
  for (let i = 0; i < end; i++) s += String.fromCharCode(bytes[i]);
  try {
    return decodeURIComponent(escape(s));
  } catch (e) {
    return s;
  }
}

/**
 * Incremental parser. Feed it raw bytes as they arrive from the socket;
 * it emits complete { command, arg0, arg1, data } messages via the
 * onMessage callback as soon as enough bytes have accumulated. Handles
 * TCP packets that split or coalesce ADB messages arbitrarily.
 */
export class MessageReader {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = new Uint8Array(0);
  }

  push(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    this._drain();
  }

  _drain() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.buffer.length < HEADER_LENGTH) return;

      const command = readUInt32LE(this.buffer, 0);
      const arg0 = readUInt32LE(this.buffer, 4);
      const arg1 = readUInt32LE(this.buffer, 8);
      const dataLength = readUInt32LE(this.buffer, 12);
      // data_check (offset 16) and magic (offset 20) are validated
      // loosely - a mismatched magic almost always means we've lost
      // frame sync, which we surface as an error rather than silently
      // discarding, so the caller can reconnect.
      const magic = readUInt32LE(this.buffer, 20);
      if (((command ^ magic) >>> 0) !== 0xffffffff) {
        throw new Error('ADB protocol desync: bad message magic');
      }

      const total = HEADER_LENGTH + dataLength;
      if (this.buffer.length < total) return; // wait for more bytes

      const data = this.buffer.slice(HEADER_LENGTH, total);
      this.buffer = this.buffer.slice(total);

      this.onMessage({ command, arg0, arg1, data });
    }
  }
}
