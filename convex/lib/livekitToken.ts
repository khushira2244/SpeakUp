/**
 * LiveKit room-join tokens, via the official `livekit-server-sdk`.
 *
 * Verified against the current LiveKit docs and the installed SDK's own
 * source (v2.19.1), not from memory:
 *   - Access tokens are JWTs signed HS256 with the API secret (`jose`'s
 *     SignJWT under the hood): { iss: apiKey, sub: identity, exp, nbf, video: {...} }.
 *   - `AccessToken(apiKey, apiSecret, { identity, ttl, name? })`, then
 *     `.addGrant({ roomJoin, room, canPublish, canSubscribe, canPublishSources, canPublishData })`,
 *     then `await .toJwt()`.
 *   - `canPublishSources: [TrackSource.MICROPHONE]` restricts publishing to
 *     audio only (camera / screen-share sources are left out).
 *
 * The SDK's own dependencies (`jose`, `@livekit/protocol`) are edge-runtime
 * compatible (the SDK ships an `@edge-runtime/vm` test target), so this runs
 * in Convex's default V8 runtime — no `"use node"` needed, matching the
 * hand-rolled-crypto precedent in lib/razorpay.ts.
 */

import { AccessToken, TrackSource } from "livekit-server-sdk";

export class LiveKitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveKitConfigError";
  }
}

function readConfig(): { apiKey: string; apiSecret: string; url: string } {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;
  if (!apiKey || apiKey.trim().length === 0 || !apiSecret || apiSecret.trim().length === 0 || !url || url.trim().length === 0) {
    throw new LiveKitConfigError(
      "LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not all set on this Convex deployment. Set them with `npx convex env set`.",
    );
  }
  return { apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), url: url.trim() };
}

export function isLiveKitConfigured(): boolean {
  try {
    readConfig();
    return true;
  } catch {
    return false;
  }
}

export type RoomRole = "learner" | "partner";

/**
 * Mints a short-lived, audio-only, publish+subscribe access token for one
 * room participant. `room` is the LiveKit room name (the booking id, so each
 * booking gets its own isolated room); `identity` is `${role}:${userId}` so
 * the room's own participant list already carries the role without a lookup.
 */
export async function mintRoomToken(args: {
  bookingId: string;
  role: RoomRole;
  userId: string;
  ttlSeconds: number;
}): Promise<{ token: string; url: string; identity: string }> {
  const { apiKey, apiSecret, url } = readConfig();
  const identity = `${args.role}:${args.userId}`;
  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    ttl: args.ttlSeconds,
  });
  token.addGrant({
    roomJoin: true,
    room: args.bookingId,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    // Audio only — this is a speaking-practice room, not video.
    canPublishSources: [TrackSource.MICROPHONE],
  });
  return { token: await token.toJwt(), url, identity };
}
