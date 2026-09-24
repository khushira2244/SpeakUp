/**
 * Profile: which languages the learner knows, which one the app uses with
 * them, which one they are learning, and gender (for Hindi verb agreement).
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  genderValidator,
  knownLanguageValidator,
  targetLanguageValidator,
} from "./schema";
import { getUserId, invalid, requireUserId } from "./lib/authz";
import { LanguageProfileError, normalizeLanguageProfile } from "./lib/languages";

const publicUserValidator = v.object({
  _id: v.id("users"),
  _creationTime: v.number(),
  name: v.union(v.string(), v.null()),
  email: v.union(v.string(), v.null()),
  /** null until updateProfile has run. */
  knownLanguages: v.union(v.array(knownLanguageValidator), v.null()),
  primaryLanguage: v.union(knownLanguageValidator, v.null()),
  targetLanguage: v.union(targetLanguageValidator, v.null()),
  gender: v.union(genderValidator, v.null()),
  createdAt: v.union(v.number(), v.null()),
});

/** The signed-in user's own profile, or `null` when signed out. */
export const me = query({
  args: {},
  returns: v.union(publicUserValidator, v.null()),
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get("users", userId);
    if (user === null) return null;
    return {
      _id: user._id,
      _creationTime: user._creationTime,
      name: user.name ?? null,
      email: user.email ?? null,
      knownLanguages: user.knownLanguages ?? null,
      primaryLanguage: user.primaryLanguage ?? null,
      targetLanguage: user.targetLanguage ?? null,
      gender: user.gender ?? null,
      createdAt: user.createdAt ?? null,
    };
  },
});

/**
 * Sets the caller's language profile and gender.
 * The target user is always the authenticated caller — never an argument.
 *
 * Rules (enforced here, server-side, via lib/languages):
 *   - knownLanguages de-duplicated, at least one
 *   - primaryLanguage must be one of knownLanguages
 *   - targetLanguage cannot be the ONLY known language
 */
export const updateProfile = mutation({
  args: {
    knownLanguages: v.array(knownLanguageValidator),
    primaryLanguage: knownLanguageValidator,
    targetLanguage: targetLanguageValidator,
    gender: genderValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    let profile;
    try {
      profile = normalizeLanguageProfile({
        knownLanguages: args.knownLanguages,
        primaryLanguage: args.primaryLanguage,
        targetLanguage: args.targetLanguage,
      });
    } catch (error) {
      if (error instanceof LanguageProfileError) invalid(error.message);
      throw error;
    }

    const existing = await ctx.db.get("users", userId);
    await ctx.db.patch("users", userId, {
      knownLanguages: profile.knownLanguages,
      primaryLanguage: profile.primaryLanguage,
      targetLanguage: profile.targetLanguage,
      gender: args.gender,
      // Backfill for rows created before `createdAt` was stamped.
      createdAt: existing?.createdAt ?? Date.now(),
    });
    return null;
  },
});
