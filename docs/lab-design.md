# SpeakUp: Lab design

Status: design decisions only. Nothing in this document is built yet.

The lab is where a learner proves what they learned that day. Learning
happens first, then the learner tries on their own, then gets corrected.

```
LEARN  ->  LAB (alone)  ->  END OF LAB (correction)  ->  optional SPEAKING  ->  MASTERY
```

Terms: **targetLanguage** is the language being learned. **primaryLanguage** is
the learner's own language, used for meanings, hints and summaries.

---

## 1. Learn (before the lab)

**Each word shows**
- its meaning (in primaryLanguage)
- its pronunciationHint
- 🔊 listen, at normal speed and slow speed

**Each pattern shows**
- an example sentence
- 🔊 listen

The learner can listen as many times as they want.

---

## 2. Lab (the learner's own attempt)

No help during the attempt.

- **Writing is the main task.** The learner writes using today's words and
  today's pattern. The shape of the task depends on their level (next section):
  it is not always fill-in-the-blank.
- **Each blank has a 🎤 option.** The learner speaks, AssemblyAI transcribes,
  and the text goes into the box. Writing stays the output.
- **No hints and no corrections** while the attempt is in progress.

---

## 2b. The lab format depends on the learner's level

Added after the mockups came back. The learner's level comes from the level
check (`starting`, `basic`, `intermediate`, `confident`) and is updated as they progress.

| Level | Lab format | How a blank is filled |
|---|---|---|
| Starting | **Fill blanks in single sentences** (the format in the mockups). Short, with a sentence starter and the word list visible before the attempt. | **Tap-to-choose** from a word bank (3–4 options). Typing from memory is too hard at this level — recognizing the right word among a few options is the actual skill being built. |
| Basic | Same single-sentence format as starting. | Still **tap-to-choose**, same reason. Basic is not yet ready to recall and spell unaided. |
| Intermediate | **One short story of several lines.** The story has blanks spread through it, and/or asks the learner to write the next lines, using today's words and pattern. | **Typed or spoken** (🎤 fills the box). Recall, not recognition. |
| Confident | **Little scaffolding.** A situation or story start, and the learner writes several lines themselves, with an unexpected twist to respond to. | **Typed or spoken**, free composition. |

Rules for every format:
- The theme (space, work, travel, football, family and so on) comes from the
  learner's interests, so the same words appear in a different story each day.
- Still no hints or corrections during the attempt.
- Each blank or line still has the 🎤 option, and the mic still only fills the box.
- Pass or not yet is still decided by whether today's words were used correctly
  in writing.
- **Tap-to-choose is weaker evidence than typed/spoken, and the mastery rule
  must know that.** With 3–4 options, a correct tap can be a guess (25–33%
  chance). A correct tap can move a word from `not_yet` to `practising`
  ("recognizes it") — it can never move a word straight to `can_use`. Only a
  typed or spoken correct answer can move a word to `can_use`. This is the
  same evidence ladder as section 7 (`written < spoken < Speaking Room`),
  extended one step further down to cover tap-recognition. Otherwise word
  counts would rise on guessing alone — exactly the fake progress the result
  screen already avoids for the level check.
- **Distractors (the wrong options in a word bank) are picked by ID from the
  goal's own word list — the same fix used for `plans.generatePlan`'s pattern
  bug.** No LLM call is needed for this: the correct word for a blank is
  already fixed by the day's plan, so 2–3 *other* words are chosen at random
  from the same goal's vocabulary (by ID, excluding the correct one and any
  word too similar in meaning to be a fair distractor). The AI is never asked
  to invent a wrong option, so it cannot invent one that fails validation.

## 2c. Grammar check (separate from the story)

Added because vocabulary and grammar are different skills, and folding
grammar practice into a vocabulary story under-tests it. Grammar gets its own
short step, using the day's pattern specifically — with a different word than
the vocabulary list, so it tests the *rule*, not memorization of one example.

```
LEARN  ->  GRAMMAR CHECK  ->  STORY / LAB (as in 2a/2b)  ->  CORRECTION  ->  optional SPEAKING
```

| Level | Grammar check format |
|---|---|
| Starting | Multiple choice: pick the correct sentence out of 3–4 options built from today's pattern. |
| Basic | Tap-to-fill the pattern's own blank from a word bank (same weaker-evidence rule as above). |
| Intermediate | Type or speak the completed sentence. |
| Confident | No separate step — grammar correctness is judged inside the free-written story itself, alongside vocabulary use. |

Rules:
- **Distractor sentences are built from the goal's own OTHER approved
  patterns (by ID), never invented.** A wrong option is a real pattern from
  this goal's pattern list rendered as a sentence, not a made-up grammar
  mistake — same principle as word-bank distractors above.
- **Grammar status updates from the lab, not only from the level check.** The
  level check sets the starting `ok` / `practising` / `not_yet` per pattern,
  but the lab's grammar-check results must keep updating it through the same
  deterministic rule (LLM proposes correctness, a fixed rule decides the
  status change) — otherwise grammar status is frozen from day one and a
  `plans.ts`-style priority ordering by "weakest pattern first" would be
  ordering on stale data forever. A `not_yet` pattern should come back for
  grammar-check practice the same way a `not_yet` word gets prioritized into
  an earlier day.
- **Scaled to the learner's daily time**, the same way `WORDS_PER_DAY` scales
  vocabulary (see `plans.ts`):

  | Minutes/day | Grammar questions | Story length |
  |---|---|---|
  | 5 | 2 | short (fits the mockup single-sentence format even at intermediate+) |
  | 15 | 3 | short story, 3–4 lines |
  | 30 | 4 | medium story, 4–6 lines |
  | 45 | 4–5 | longer story, up to ~8 lines |

  A 5-minute learner cannot do Learn + a full grammar check + a full story +
  correction in 5 minutes, so the whole day's shape (not just word count)
  scales with `minutesPerDay`, not only the story.

## 2d. Everything is generated dynamically

The Words dictionary, units, concepts and labs are all generated by AI for that
learner, when needed. None of them is a fixed lesson list.
- Every generated item is checked by rules before it is saved (the same rule as the
  rest of the backend). The AI never writes learner state directly.
- Generated items are cached, so opening the same item again costs nothing.
- All of it happens only while the pass is active.

---

## 3. End of lab (correction)

- Right answers are marked ✅.
- For each wrong or missing answer:
  - the correct word is filled in,
  - it is spoken aloud 🔊,
  - the learner repeats it once.
- A short summary is shown in primaryLanguage.

---

## 4. Optional speaking (end of lab)

- The learner may speak the completed sentences.
- **If they speak:** stronger evidence (spoken counts for more than written).
- **If they don't:** the app speaks the sentences for them. No penalty.

---

## 5. Mastery

- **Pass:** most of the day's words are used correctly **in writing**
  (example: 4 of 5).
- **Pass** moves the learner to the next topic.
- **Not yet** keeps the same topic at the same level, with a retry lab
  focused only on the missed items.

---

## 6. Generation and cost rules

| Case | Rule | Cost to learner |
|---|---|---|
| Day lab | One lab per day, generated when that day opens, while the pass is active (see `home-design.md`). Never auto-regenerated. | Included in the time pass |
| System retry (learner did not pass) | Small, covers only the missed items, max 2 per day | Free |
| Learner asks for a new lab for variety | Uses the existing regen purchase | Paid |

---

## 7. Evidence

```
written correct  <  spoken correct  <  used in Speaking Room
```

- The **LLM proposes** corrections.
- **Deterministic rules decide** pass/fail and update skill state.
- The LLM never writes learner state directly (same rule as the rest of the
  backend).

---

## Fit with what already exists

Written by me while saving this doc, not decisions from the design session.

- Plans already hold, per day, the words (with meaning, and pronunciationHint
  once the language task lands) and the pattern. The lab is built from
  that day's content, so it needs no new goal-level data.
- Day and week purchases and the paid `regen` purchase already exist. The
  "generated once per purchase" and "paid regeneration" rules map onto them.
- The backend's rule of validating LLM output and then applying deterministic
  rules before any write is the same rule this design uses in section 7.
- Evidence levels and skill state (can use / practising / not yet) are not
  implemented yet. The lab would be their first writer.
- The AssemblyAI streaming setup (short-lived token, per-language model) is
  what the 🎤 button in a blank would use.

## Open questions for tomorrow

Also my additions. Each needs a decision before building.

1. **Does dictating into a blank count as written or spoken evidence?** The
   design says writing stays the output, which suggests written. Confirm.
2. **What exactly is "most"?** 4 of 5 is 80%. Is the rule a percentage
   (which handles labs of 3 or 7 words) or a fixed count per lab size?
3. **What happens after the 2 free retries are used up?** Stay on the topic,
   offer the paid regen, or move on with the topic marked not yet mastered?
4. **How is "repeats once" checked?** Only recorded and encouraged, or
   transcribed and compared to the correct word?
5. **How lenient is written matching?** For German: umlauts, ß, capital
   nouns, and small typos. For Hindi/Telugu-script hints there is nothing to
   match, since the answers are in the target language.
6. **Where does 🔊 audio come from?** Unlimited listening is only affordable
   if audio is generated once per word or sentence and cached. A German
   voice must also be good enough to teach from.
7. **Are retry labs generated by the LLM?** "Free, small" means they still
   cost an LLM call each. Confirm that is acceptable, at up to 2 per day.

8. **How is a story lab marked?** For blanks it is easy: the word is right or
   wrong. For lines the learner writes freely, "used correctly" is a judgement.
   Proposal: the LLM proposes whether each target word was used correctly and
   why, and the deterministic rule requires the word to actually appear in the
   learner's text before it can count. Confirm.
9. ~~How long is a story?~~ **Resolved by the time-budget table in 2c**:
   story length now scales with `minutesPerDay`, alongside grammar-question
   count. The 4–6 / 6–10 line proposal still roughly holds at 30/45 minutes.
10. **Does a wrong answer ever demote a word or pattern that already reached
    `can_use` / `ok`?** Not decided. Proposal: no demotion from a single
    miss (matches "practising" already being a low bar to leave once
    reached); only repeated misses across several days would demote. Needs a
    rule before the lab writes any status.
11. **Do grammar-check questions cost an LLM call each?** The distractor
    *choice* is free (picked by ID, no AI). But turning a pattern + a word
    into an actual sentence to display is still generation, so each
    grammar-check question likely costs one call, same as a plan day. At
    2–5 questions/day (see 2c's table) this adds up — confirm it is
    acceptable, or consider caching per (pattern, word) pair so the same
    combination is never regenerated for other learners on the same goal type.
12. **Word-bank distractors: how is "too similar in meaning to be fair"
    decided?** Random-by-ID is simple but could pick a near-synonym as a
    wrong option by chance. Needs either a simple rule (e.g. exclude words
    sharing a normalized meaning-language prefix) or accept the occasional
    unfair distractor for v1.

## Suggested build order (a suggestion, not a decision)

1. Learn screens with listening, since listening is the cheapest piece and
   depends on the audio decision above.
2. Lab generation and the writing attempt (no mic yet).
3. End-of-lab correction and the mastery rule, with deterministic pass/fail.
4. 🎤 in blanks, then optional speaking.
5. Skill state and evidence levels, then system retries.
