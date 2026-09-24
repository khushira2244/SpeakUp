/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as dev from "../dev.js";
import type * as goals from "../goals.js";
import type * as home from "../home.js";
import type * as http from "../http.js";
import type * as levelCheck from "../levelCheck.js";
import type * as lib_assemblyai from "../lib/assemblyai.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_languages from "../lib/languages.js";
import type * as lib_llm from "../lib/llm.js";
import type * as lib_validate from "../lib/validate.js";
import type * as llmMetrics from "../llmMetrics.js";
import type * as migrations from "../migrations.js";
import type * as plans from "../plans.js";
import type * as purchases from "../purchases.js";
import type * as scoring from "../scoring.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  dev: typeof dev;
  goals: typeof goals;
  home: typeof home;
  http: typeof http;
  levelCheck: typeof levelCheck;
  "lib/assemblyai": typeof lib_assemblyai;
  "lib/authz": typeof lib_authz;
  "lib/languages": typeof lib_languages;
  "lib/llm": typeof lib_llm;
  "lib/validate": typeof lib_validate;
  llmMetrics: typeof llmMetrics;
  migrations: typeof migrations;
  plans: typeof plans;
  purchases: typeof purchases;
  scoring: typeof scoring;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
