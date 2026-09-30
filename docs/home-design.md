# SpeakUp: Payment and Home

Status: design decisions only. Nothing in this document is built yet.

```
Level check  ->  Result  ->  PAYMENT (time pass)  ->  HOME
                                                       |- Pronunciation
                                                       |- Words
                                                       |- Units
```

## Decided (from the design session)

**Nothing is free after the level check.**
- The result screen is shown, then the payment screen, then Home.
- Units, plans and labs are generated only after payment.

**Payment**
- One payment buys a **time pass** (a week or a month).
- It stays a demo payment for now (no real money).

**Home has three tabs**

1. **Pronunciation**
   - An absolute beginner sees **letter** pronunciation.
   - Anyone else sees **saved words on top, goal words below**.
   - Any learner can **add their own word** to a saved list to practise saying it.
2. **Words**
   - Each word with its **meaning in the learner's own language**.
3. **Units**
   - A unit has **concepts**, a **plan**, and **one lab generated every day**.

**Audio (🔊)** comes from the phone/browser voice first. A better cloud voice can
replace it later.

**Everything is generated dynamically** (added later)
- The Words dictionary, units, concepts and labs are AI-generated for the learner,
  checked by rules, cached, and only while the pass is active.
- Labs are not only fill-in-the-blank: intermediate learners get a multi-line story
  (see `lab-design.md`, section 2b).
- Proposal: the Words tab is a **dictionary**. It lists the goal words and the words
  from units, and has a search field. Looking up any word generates its entry
  (meaning, sound hint, example) once, and the learner can save it to Pronunciation.

## Mockups received (12 images)

They match this design, with these differences. Each needs a decision or a fix.

1. **Tabs.** The Pronunciation mockups show 2 tabs, "Conversation" and
   "Pronunciation" (one has the typo "Ponversation"), and the Hindi letters
   mockup shows only "उच्चारण" and "शब्द". The design has 3 tabs:
   Pronunciation, Words, Units. I will build 3.
2. **Bottom navigation** differs. The English mockups show Home, Practice and Rooms
   ("Coming soon"). The Hindi Units mockups show होम, सीखें, अपनी प्रगति and
   प्रोफ़ाइल. I will build the first one, which matches the earlier mockups.
3. **Words per day.** The Hindi plan mockup shows 8, 6, 5, 8, 7, 6 and 10 words on
   different days. The backend rule is fixed by daily time (5 minutes: 3, 15: 5,
   30: 7, 45: 9), and the English mockup shows 5 a day. I will use the backend rule.
4. **Sound hints.** The Hindi lab mockup shows the hint in Latin letters
   ("bowkh"). Hints for a Hindi learner are written in Devanagari ("बाउख").
5. **Illustrations.** The unit cards show a drawn doctor and patient. I will use
   simple icons unless you supply image files.
6. **Lab.** The mockups show fill-in-the-blank only. The story format for
   intermediate learners still needs a mockup.
7. **Small fixes.** "Grammaa topics" typo on the result screen. In the beginner
   result, the "first 5 words" card has empty radio circles that look tappable;
   those rows should be plain. The correction screen mixes English answers
   (doctor, pain) with a German correction (Fieber) in a German lab.

## What this changes in what already exists

| Today | New |
|---|---|
| The 7-day plan (or Quick Prep) is generated automatically right after scoring | Plans and units are generated only after payment |
| Day 1 is a free preview | No free preview |
| Purchases are per day, per week, or Quick Prep, plus paid regen | One time pass. Regen stays a separate paid action |
| The lab is generated once per purchase (see `lab-design.md`) | One lab per day |
| Goal words (about 40) are generated when the goal is saved | Unchanged: the level check needs them, so they stay before payment |

New data will be needed for: passes, letters, saved words, and units.
The level check screens and the result screen also do not exist in the frontend yet.

## My proposals (not yet decided)

Each needs your yes or a change.

1. **Pass length and price.** Weekly at $4.99 (today's week price) and monthly at
   $14.99. Both provisional and demo-only.
2. **"Absolute beginner"** means the level check result is `starting`
   (under 15% of the goal words known).
3. **Letters.**
   - English: A to Z. German: A to Z plus ä ö ü ß.
   - Each letter has its name, example sounds, and a sound hint in the learner's own script.
   - Generated once per language pair and shared by all learners, not per learner.
4. **Saved words.** The learner types or speaks a word. It gets a meaning and a
   sound hint (cached), and joins the list. Suggested limit: 50 words.
5. **A unit** is one topic: 2 to 4 concepts (patterns with examples), a 7-day plan
   built like today's week plan, and a lab each day. Unit 1 is generated at
   payment. The next unit is generated when the learner passes the current one.
6. **Daily labs are generated when that day opens**, not ahead of time, so an
   unused day costs nothing. Retry and regeneration rules stay as in `lab-design.md`.
7. **When a pass ends,** all three tabs lock, and nothing is deleted. Saved words
   and progress return when the learner renews.

## Suggested build order

1. **Level check and result screens** (backend already exists).
2. **Pass backend and the payment screen** (demo), and stop generating the plan
   before payment.
3. **Home shell with the three tabs, and the Words tab** (the words already exist).
4. **Pronunciation tab:** letters, saved words, and the phone voice.
5. **Units tab:** unit generation after payment, concepts, and the plan.
6. **Daily lab**, as designed in `lab-design.md`.
