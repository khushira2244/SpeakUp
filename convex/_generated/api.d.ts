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
import type * as dictionary from "../dictionary.js";
import type * as goals from "../goals.js";
import type * as home from "../home.js";
import type * as http from "../http.js";
import type * as labs from "../labs.js";
import type * as levelCheck from "../levelCheck.js";
import type * as lib_assemblyai from "../lib/assemblyai.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_labValidate from "../lib/labValidate.js";
import type * as lib_languages from "../lib/languages.js";
import type * as lib_liveRoom from "../lib/liveRoom.js";
import type * as lib_livekitToken from "../lib/livekitToken.js";
import type * as lib_llm from "../lib/llm.js";
import type * as lib_passes from "../lib/passes.js";
import type * as lib_razorpay from "../lib/razorpay.js";
import type * as lib_roomScript from "../lib/roomScript.js";
import type * as lib_rooms from "../lib/rooms.js";
import type * as lib_safety from "../lib/safety.js";
import type * as lib_validate from "../lib/validate.js";
import type * as liveRoom from "../liveRoom.js";
import type * as llmMetrics from "../llmMetrics.js";
import type * as migrations from "../migrations.js";
import type * as partnerPayouts from "../partnerPayouts.js";
import type * as partners from "../partners.js";
import type * as passes from "../passes.js";
import type * as payments from "../payments.js";
import type * as plans from "../plans.js";
import type * as purchases from "../purchases.js";
import type * as rooms from "../rooms.js";
import type * as savedWords from "../savedWords.js";
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
  dictionary: typeof dictionary;
  goals: typeof goals;
  home: typeof home;
  http: typeof http;
  labs: typeof labs;
  levelCheck: typeof levelCheck;
  "lib/assemblyai": typeof lib_assemblyai;
  "lib/authz": typeof lib_authz;
  "lib/labValidate": typeof lib_labValidate;
  "lib/languages": typeof lib_languages;
  "lib/liveRoom": typeof lib_liveRoom;
  "lib/livekitToken": typeof lib_livekitToken;
  "lib/llm": typeof lib_llm;
  "lib/passes": typeof lib_passes;
  "lib/razorpay": typeof lib_razorpay;
  "lib/roomScript": typeof lib_roomScript;
  "lib/rooms": typeof lib_rooms;
  "lib/safety": typeof lib_safety;
  "lib/validate": typeof lib_validate;
  liveRoom: typeof liveRoom;
  llmMetrics: typeof llmMetrics;
  migrations: typeof migrations;
  partnerPayouts: typeof partnerPayouts;
  partners: typeof partners;
  passes: typeof passes;
  payments: typeof payments;
  plans: typeof plans;
  purchases: typeof purchases;
  rooms: typeof rooms;
  savedWords: typeof savedWords;
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
