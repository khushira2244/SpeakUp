import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";

export type RoomRole = "learner" | "partner";

export type RoomStateDoc = FunctionReturnType<typeof api.liveRoom.roomState>;
export type RoomScriptDoc = NonNullable<FunctionReturnType<typeof api.rooms.latestScript>>;
export type RoomBookingDetailDoc = FunctionReturnType<typeof api.rooms.roomBookingDetail>;
