/**
 * Instrumentation for LLM Gateway usage.
 *
 * `lib/llm.ts` records one row per HTTP request it actually sends — including
 * the retry — so a caller can prove how many gateway calls a given run made.
 * The seed script uses this to assert that an idempotent re-run makes ZERO.
 *
 * This is observability, not learner state: nothing here feeds the scoring or
 * planning pipelines.
 */

import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUserId } from "./lib/authz";
import type { LlmCallRecord } from "./lib/llm";

/** Internal: append a call row and bump the running total. */
export const record = internalMutation({
  args: {
    model: v.string(),
    schemaName: v.string(),
    attempt: v.number(),
    ok: v.boolean(),
    errorName: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("llmCalls", {
      at: Date.now(),
      model: args.model,
      schemaName: args.schemaName,
      attempt: args.attempt,
      ok: args.ok,
      errorName: args.errorName,
      errorMessage: args.errorMessage,
    });

    const counter = await ctx.db.query("llmCallCounter").first();
    if (counter === null) {
      await ctx.db.insert("llmCallCounter", { count: 1 });
    } else {
      await ctx.db.patch("llmCallCounter", counter._id, { count: counter.count + 1 });
    }
    return null;
  },
});

/**
 * Running total of gateway calls on this deployment. Callers take a reading
 * before and after a run and diff them, which avoids any dependence on clock
 * agreement between the script's machine and the deployment.
 */
export const total = query({
  args: {},
  returns: v.object({ count: v.number() }),
  handler: async (ctx) => {
    await requireUserId(ctx);
    const counter = await ctx.db.query("llmCallCounter").first();
    return { count: counter?.count ?? 0 };
  },
});

/** The most recent calls, newest first — for diagnosing an unexpected call. */
export const recent = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      at: v.number(),
      model: v.string(),
      schemaName: v.string(),
      attempt: v.number(),
      ok: v.boolean(),
      errorName: v.union(v.string(), v.null()),
      errorMessage: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireUserId(ctx);
    const requested = args.limit ?? 20;
    const limit =
      Number.isFinite(requested) && requested > 0 ? Math.min(100, Math.floor(requested)) : 20;
    const rows = await ctx.db.query("llmCalls").withIndex("by_at").order("desc").take(limit);
    return rows.map((row) => ({
      at: row.at,
      model: row.model,
      schemaName: row.schemaName,
      attempt: row.attempt,
      ok: row.ok,
      errorName: row.errorName ?? null,
      errorMessage: row.errorMessage ?? null,
    }));
  },
});

/**
 * Builds the recorder that `llmJson` calls after every gateway request.
 * Keeps `lib/llm.ts` free of generated-API imports.
 *
 * Recording must never break a generation, so failures here are swallowed.
 */
export function llmRecorder(ctx: ActionCtx): (entry: LlmCallRecord) => Promise<void> {
  return async (entry: LlmCallRecord) => {
    try {
      await ctx.runMutation(internal.llmMetrics.record, {
        model: entry.model,
        schemaName: entry.schemaName,
        attempt: entry.attempt,
        ok: entry.ok,
        errorName: entry.errorName,
        errorMessage: entry.errorMessage,
      });
    } catch (error) {
      console.warn(
        `llmMetrics.record failed (ignored): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}
