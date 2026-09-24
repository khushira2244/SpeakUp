import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import Google from "@auth/core/providers/google";
import type { Value } from "convex/values";

/**
 * Convex Auth configuration: email/password + Google OAuth.
 *
 * Google requires AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET on the deployment:
 *   npx convex env set AUTH_GOOGLE_ID <client-id>
 *   npx convex env set AUTH_GOOGLE_SECRET <client-secret>
 *
 * The matching `convex/auth.config.ts` MUST exist alongside this file, or
 * `ctx.auth.getUserIdentity()` silently returns null on every request.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      // Runs for sign-up AND sign-in: lower-casing keeps "Ana@x.com" and
      // "ana@x.com" one account. `name` only arrives on sign-up.
      profile(params) {
        const email = String(params.email ?? "").trim().toLowerCase();
        const name = typeof params.name === "string" ? params.name.trim() : "";
        const profile: { [field: string]: Value; email: string } = { email };
        if (name.length > 0) profile.name = name.slice(0, 80);
        return profile;
      },
    }),
    Google,
  ],
  callbacks: {
    /**
     * Stamp `createdAt` once, at account creation. Subsequent sign-ins leave it
     * alone so the profile's original creation time is never rewritten.
     */
    async afterUserCreatedOrUpdated(ctx, { userId, existingUserId }) {
      if (existingUserId !== null) return;
      await ctx.db.patch("users", userId, { createdAt: Date.now() });
    },
  },
});
