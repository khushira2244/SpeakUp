"use client";

import { useState } from "react";
import { Lobby } from "@/components/live-room/lobby";
import { LiveRoomView } from "@/components/live-room/live-room-view";
import { SessionEndedScreen } from "@/components/live-room/session-ended-screen";
import type { RoomAudioApi } from "@/components/live-room/use-room-audio";
import type { RoomRole, RoomScriptDoc, RoomStateDoc } from "@/components/live-room/types";

const SCRIPT: RoomScriptDoc = {
  version: 1,
  generatedByLLM: true,
  lines: [
    { role: "partner", text: "Hi, thanks for meeting today.", words: [] },
    { role: "learner", text: "I wanted to give an update about the project delay.", words: ["delay"] },
    { role: "partner", text: "Can you explain what caused the delay?", words: ["delay"] },
    { role: "learner", text: "The main issue was a change in requirements.", words: ["update"] },
    { role: "partner", text: "How will you make sure we meet the new deadline?", words: ["deadline"] },
    { role: "learner", text: "I will send a written plan and check in every two days.", words: ["deadline", "update"] },
  ],
};

function baseState(overrides: Partial<RoomStateDoc>): RoomStateDoc {
  const now = Date.now();
  return {
    status: "in_progress",
    role: "learner",
    scheduledStartAt: now - 3 * 60_000,
    scheduledEndAt: now + 6 * 60_000 + 42_000,
    msRemaining: 6 * 60_000 + 42_000,
    learnerJoined: true,
    partnerJoined: true,
    currentLineIndex: 1,
    doneLineIndices: [],
    totalLines: SCRIPT.lines.length,
    targetWordsSaid: [{ word: "delay", confidence: 0.9 }],
    stuckCue: false,
    myStrikes: 0,
    otherStrikes: 0,
    warning: null,
    endedReason: null,
    violatorRole: null,
    ...overrides,
  };
}

function mockAudio(overrides: Partial<RoomAudioApi> = {}): RoomAudioApi {
  return {
    phase: "live",
    micLevel: 0.4,
    liveText: "I wanted to give an update about the project delay",
    remoteSpeaking: false,
    connectionIssue: null,
    errorCode: null,
    muted: false,
    connect: async () => {},
    leave: async () => {},
    toggleMute: () => {},
    ...overrides,
  };
}

type Scenario = {
  key: string;
  label: string;
  render: () => React.ReactNode;
};

const SCENARIOS: Scenario[] = [
  {
    key: "lobby",
    label: "1. Lobby",
    render: () => (
      <Lobby
        role="learner"
        roomState={baseState({ status: "confirmed", partnerJoined: true, learnerJoined: false, scheduledStartAt: Date.now() + 80_000 })}
        script={SCRIPT}
        joining={false}
        joinError={null}
        onJoin={() => {}}
        onBack={() => {}}
      />
    ),
  },
  {
    key: "learner-normal",
    label: "2. Live room — learner",
    render: () => (
      <LiveRoomView role="learner" roomState={baseState({ role: "learner" })} script={SCRIPT} audio={mockAudio({ remoteSpeaking: true })} onLeave={() => {}} onReport={async () => {}} />
    ),
  },
  {
    key: "partner-normal",
    label: "3. Live room — partner",
    render: () => (
      <LiveRoomView role="partner" roomState={baseState({ role: "partner" })} script={SCRIPT} audio={mockAudio({ liveText: "Can you explain what caused the delay?" })} onLeave={() => {}} onReport={async () => {}} />
    ),
  },
  {
    key: "stuck-learner",
    label: "4. Stuck moment — learner",
    render: () => (
      <LiveRoomView role="learner" roomState={baseState({ role: "learner", stuckCue: true })} script={SCRIPT} audio={mockAudio({ liveText: "" })} onLeave={() => {}} onReport={async () => {}} />
    ),
  },
  {
    key: "stuck-partner",
    label: "4b. Stuck cue — partner",
    render: () => (
      <LiveRoomView role="partner" roomState={baseState({ role: "partner", stuckCue: true })} script={SCRIPT} audio={mockAudio({ liveText: "" })} onLeave={() => {}} onReport={async () => {}} />
    ),
  },
  {
    key: "warning",
    label: "5. Safety warning banner",
    render: () => (
      <LiveRoomView
        role="learner"
        roomState={baseState({ role: "learner", warning: { role: "partner", reason: "blocked term detected", at: Date.now() } })}
        script={SCRIPT}
        audio={mockAudio()}
        onLeave={() => {}}
        onReport={async () => {}}
      />
    ),
  },
  {
    key: "ended-violation-other",
    label: "5b. Session ended — violation (them)",
    render: () => <SessionEndedScreen reason="violation" role="learner" violatorRole="partner" bookingId="mock" onReport={async () => {}} />,
  },
  {
    key: "ended-violation-you",
    label: "5c. Session ended — violation (you)",
    render: () => <SessionEndedScreen reason="violation" role="partner" violatorRole="partner" bookingId="mock" onReport={async () => {}} />,
  },
  {
    key: "ended-completed",
    label: "5d. Session ended — completed",
    render: () => <SessionEndedScreen reason="completed" role="learner" violatorRole={null} bookingId="mock" onReport={async () => {}} />,
  },
  {
    key: "ended-no-show",
    label: "5e. Session ended — partner no-show",
    render: () => <SessionEndedScreen reason="no_show" role="learner" violatorRole={null} bookingId="mock" onReport={async () => {}} />,
  },
];

export function RoomPreviewClient() {
  const [key, setKey] = useState(SCENARIOS[0]!.key);
  const scenario = SCENARIOS.find((s) => s.key === key)!;

  return (
    <div className="min-h-dvh bg-bg">
      <div className="flex flex-wrap gap-2 border-b border-line p-3">
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setKey(s.key)}
            className={
              "rounded-full border px-3 py-1.5 text-sm " +
              (s.key === key ? "border-accent bg-accent/15 text-fg" : "border-line-strong text-muted")
            }
          >
            {s.label}
          </button>
        ))}
      </div>
      {scenario.render()}
    </div>
  );
}
