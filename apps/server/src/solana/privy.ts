import { createPublicKey, verify } from 'node:crypto';
/** Checks a Privy access token (ES256 JWT) and returns the user's id, or null. No network call, no app secret. */
export function verifyPrivy(token: string | undefined, appId: string, publicKeyPem: string, now = Date.now()): string | null {
  if (!token) return null;
  const part = token.split('.'); if (part.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(part[0], 'base64url').toString()), body = JSON.parse(Buffer.from(part[1], 'base64url').toString());
    if (head.alg !== 'ES256' || body.iss !== 'privy.io' || body.aud !== appId) return null;
    if (typeof body.exp !== 'number' || body.exp * 1000 <= now || typeof body.sub !== 'string' || !body.sub.startsWith('did:privy:')) return null;
    if (!verify('sha256', Buffer.from(`${part[0]}.${part[1]}`), { key: createPublicKey(publicKeyPem), dsaEncoding: 'ieee-p1363' }, Buffer.from(part[2], 'base64url'))) return null;
    return body.sub;
  } catch { return null; }
}
