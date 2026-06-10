import { SignJWT, jwtVerify } from "jose";

const HASH_NAME = "sha256";
const HASH_ALGORITHM = `pbkdf2_${HASH_NAME}`;
const HASH_ITERATIONS = 240_000;
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

type SessionPayload = {
  userId: number;
  expiresAt: number;
};

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...view].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    return new Uint8Array();
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return bytesToHex(buffer);
}

async function derivePasswordDigest(password: string, salt: string, iterations: number): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations
    },
    key,
    256
  );
  return bytesToHex(bits);
}

function jwtKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomHex(16);
  const digest = await derivePasswordDigest(password, salt, HASH_ITERATIONS);
  return `${HASH_ALGORITHM}$${HASH_ITERATIONS}$${salt}$${digest}`;
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const [algorithm, rawIterations, salt, digest] = passwordHash.split("$");
  if (algorithm !== HASH_ALGORITHM || !rawIterations || !salt || !digest) {
    return false;
  }
  const iterations = Number.parseInt(rawIterations, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false;
  }
  const expected = await derivePasswordDigest(password, salt, iterations);
  return equalBytes(hexToBytes(expected), hexToBytes(digest));
}

export async function signSession(userId: number, secret: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(jwtKey(secret));
}

export async function verifySession(token: string, secret: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, jwtKey(secret), { algorithms: ["HS256"] });
  const userId = Number.parseInt(String(payload.sub || ""), 10);
  if (!Number.isFinite(userId)) {
    throw new Error("Invalid session subject");
  }
  return {
    userId,
    expiresAt: typeof payload.exp === "number" ? payload.exp : 0
  };
}

export const sessionMaxAgeSeconds = SESSION_MAX_AGE_SECONDS;
