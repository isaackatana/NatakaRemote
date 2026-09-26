/**
 * adbCrypto.js
 *
 * Implements the RSA machinery ADB's auth handshake needs:
 *
 *  1. Generate (or load a persisted) 2048-bit RSA keypair.
 *  2. Sign the 20-byte random token the device sends in an AUTH(TOKEN)
 *     message, producing the AUTH(SIGNATURE) payload.
 *  3. Encode the public key into the binary "ADB RSA public key" blob
 *     format the device expects in AUTH(RSAPUBLICKEY) - this is the
 *     structure the on-device "Allow USB debugging?" dialog fingerprints
 *     and, once accepted, stores in adb_keys / /data/misc/adb/adb_keys.
 *
 * Pure JS, built on `node-forge` so it runs inside the React Native JS
 * engine without a native crypto bridge. node-forge's low-level
 * `pki.rsa.decrypt(..., pub=false, pkcs1=false)` performs a *raw* RSA
 * private-key modular exponentiation with no padding logic of its own -
 * exactly the primitive ADB's signing scheme needs, since ADB does its
 * own PKCS#1-v1.5-style padding by hand below.
 */

import forge from 'node-forge';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_SIZE_BITS = 2048;
const KEY_SIZE_BYTES = KEY_SIZE_BITS / 8; // 256
const KEY_SIZE_WORDS = KEY_SIZE_BITS / 32; // 64
const SHA1_DIGEST_LEN = 20;

const STORAGE_KEY_PRIVATE = '@nataka_remote/adb_private_key_pem';
const STORAGE_KEY_PUBLIC = '@nataka_remote/adb_public_key_pem';

// Standard PKCS#1 v1.5 DigestInfo DER prefix for SHA-1 (RFC 3447,
// widely published, e.g. in OpenSSL's rsa_sign.c). ADB re-uses this
// exact prefix even though the 20 bytes that follow are the *token*
// ADB sent us, not an actual SHA-1 hash we computed - ADB treats the
// token itself as if it were the digest.
const ASN1_SHA1_PREFIX = new Uint8Array([
  0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05,
  0x00, 0x04, 0x14,
]);

function bytesToBinaryString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function binaryStringToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

/** Big-endian forge BigInteger -> fixed-length little-endian byte array. */
function bigIntToLEBytes(bn, byteLen) {
  let hex = bn.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const be = [];
  for (let i = 0; i < hex.length; i += 2) {
    be.push(parseInt(hex.substr(i, 2), 16));
  }
  while (be.length < byteLen) be.unshift(0);
  const trimmed = be.length > byteLen ? be.slice(be.length - byteLen) : be;
  return new Uint8Array(trimmed.reverse());
}

/**
 * Load the persisted ADB keypair, or generate and persist a new one.
 * Re-using the same key across app launches matters: the "Allow USB
 * debugging" prompt on the TV, once accepted, whitelists this specific
 * public key. Generating a new key every launch would force the user to
 * re-approve on the TV screen every single time.
 */
export async function getOrCreateAdbKeyPair() {
  const [storedPriv, storedPub] = await Promise.all([
    AsyncStorage.getItem(STORAGE_KEY_PRIVATE),
    AsyncStorage.getItem(STORAGE_KEY_PUBLIC),
  ]);

  if (storedPriv && storedPub) {
    return {
      privateKey: forge.pki.privateKeyFromPem(storedPriv),
      publicKeyBlob: storedPub,
    };
  }

  const { privateKey, publicKey } = forge.pki.rsa.generateKeyPair({
    bits: KEY_SIZE_BITS,
    e: 0x10001,
  });

  const publicKeyBlob = encodeAdbPublicKey(publicKey);
  const privatePem = forge.pki.privateKeyToPem(privateKey);

  await Promise.all([
    AsyncStorage.setItem(STORAGE_KEY_PRIVATE, privatePem),
    AsyncStorage.setItem(STORAGE_KEY_PUBLIC, publicKeyBlob),
  ]);

  return { privateKey, publicKeyBlob };
}

/**
 * Encode a forge RSA public key into ADB's binary "RSAPublicKey" struct,
 * base64 it, and append " user@host" as `adb` itself does, so the
 * fingerprint shown in the TV's approval dialog looks familiar.
 *
 * struct RSAPublicKey {
 *   uint32_t modulus_size_words; // n.bitLength() / 32
 *   uint32_t n0inv;              // -n^-1 mod 2^32
 *   uint8_t  n[256];             // modulus, little-endian
 *   uint8_t  rr[256];            // (R^2 mod n), little-endian, R = 2^2048
 *   uint32_t exponent;           // public exponent (65537)
 * };
 */
export function encodeAdbPublicKey(publicKey, name = 'reactnative@nataka-remote') {
  const n = publicKey.n;
  const e = publicKey.e.intValue();

  const R = forge.jsbn.BigInteger.ONE.shiftLeft(KEY_SIZE_BITS);
  const RR = R.multiply(R).mod(n);

  const TWO_32 = forge.jsbn.BigInteger.ONE.shiftLeft(32);
  const nInvMod32 = n.modInverse(TWO_32);
  const n0inv = TWO_32.subtract(nInvMod32).mod(TWO_32);

  const buf = new Uint8Array(4 + 4 + KEY_SIZE_BYTES + KEY_SIZE_BYTES + 4);
  let offset = 0;
  const writeLE32 = (val) => {
    buf[offset++] = val & 0xff;
    buf[offset++] = (val >>> 8) & 0xff;
    buf[offset++] = (val >>> 16) & 0xff;
    buf[offset++] = (val >>> 24) & 0xff;
  };

  writeLE32(KEY_SIZE_WORDS);
  writeLE32(n0inv.intValue());
  buf.set(bigIntToLEBytes(n, KEY_SIZE_BYTES), offset);
  offset += KEY_SIZE_BYTES;
  buf.set(bigIntToLEBytes(RR, KEY_SIZE_BYTES), offset);
  offset += KEY_SIZE_BYTES;
  writeLE32(e);

  const b64 = forge.util.encode64(bytesToBinaryString(buf));
  return `${b64} ${name}\n`;
}

/**
 * Sign a 20-byte ADB auth token with the private key, producing the
 * 256-byte AUTH(SIGNATURE) payload.
 *
 * Builds a manual PKCS#1 v1.5 block:
 *   00 01 FF FF ... FF 00 <SHA1 DigestInfo prefix> <20-byte token>
 * padded to exactly one RSA-modulus's worth of bytes, then performs a
 * raw RSA private-key operation (modular exponentiation) over it - not
 * a "hash then sign", because the token itself stands in for the hash.
 */
export function signAdbToken(token, privateKey) {
  if (token.length !== SHA1_DIGEST_LEN) {
    throw new Error(`ADB auth token must be ${SHA1_DIGEST_LEN} bytes`);
  }

  const block = new Uint8Array(KEY_SIZE_BYTES);
  const padLen =
    KEY_SIZE_BYTES - 3 - ASN1_SHA1_PREFIX.length - SHA1_DIGEST_LEN;

  let i = 0;
  block[i++] = 0x00;
  block[i++] = 0x01;
  for (let j = 0; j < padLen; j++) block[i++] = 0xff;
  block[i++] = 0x00;
  block.set(ASN1_SHA1_PREFIX, i);
  i += ASN1_SHA1_PREFIX.length;
  block.set(token, i);

  // pub=false -> use the private key; pkcs1(ps)=false -> raw modexp,
  // we've already built the padding ourselves above.
  const signedBinaryString = forge.pki.rsa.decrypt(
    bytesToBinaryString(block),
    privateKey,
    false,
    false
  );

  return binaryStringToBytes(signedBinaryString);
}

/** Clears the persisted keypair - useful if the device's trust list is reset. */
export async function forgetAdbKeyPair() {
  await Promise.all([
    AsyncStorage.removeItem(STORAGE_KEY_PRIVATE),
    AsyncStorage.removeItem(STORAGE_KEY_PUBLIC),
  ]);
}
