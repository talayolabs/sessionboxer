---
name: e2e-verification
description: Verify the turn that just finished end to end on the Sandbox desktop — decide whether anything testable changed, plan 2–5 test cases, run them with the desktop tools while recording, fix and rerun failures, and finish with a video. Use it when a Sessionboxer message asks you to verify a turn (a verification run is open), or when the user asks for an end-to-end check of your work.
---

# End-to-end verification of a turn

Sessionboxer keeps a **verification run** for the turn being checked: its test
cases, their status, timings, cycles and the final video, shown live to the
user in the Verification pane. The Control Plane opens the run and sends you
the message that starts this skill; you fill the run in with the `e2e_*` tools
of the `desktop` MCP server (`e2e_plan`, `e2e_case_start`, `e2e_case_end`,
`e2e_finish`). The run opens after a user turn when the switch "Verify each
turn" is on, or when the user presses **Run now** in the Verification pane; in
that case the message says so and the work so far is what you verify, against
the user's last request. Do not start a verification on your own during a
normal turn; if a user asks for one, do the work and mention the switch and
the Run now button.

Work through the five steps in order. Stay on this task: no unrelated work, no
questions to the user, and never another verification of this verification.

## 1. Decide

Find out what the turn changed:

- In every repository under `/workspace` (see `/workspace/.sessionboxer/repos.json`),
  run `git status --short` and `git diff --stat`. If the turn committed, also
  diff against the state before the turn (`git diff --stat <base>..HEAD`, or
  `git log --stat -n <commits of this turn>`).
- Consider what the user asked and what you did: code change, configuration,
  documentation, or only an answer, research or explanation.

Skip when nothing can be exercised on the desktop: nothing changed, only an
answer or notes were produced, or the change has no observable behavior (a
comment, a typo in an internal log line, a dependency bump with no visible
effect). Then call

```
e2e_plan({ cases: [], skip_reason: "<one sentence>" })
```

and end your reply with one line saying the verification was skipped and why.
No recording, no cases.

Documentation with rendered output (a README, a docs site), scripts, CLIs and
servers are testable: open the result in the browser, a terminal or VS Code.

## 2. Plan

Derive the test cases from the user's request (quoted in the message that
started this skill) and from what you understood you were asked to do — not
from the code alone. Aim for **2 to 5 cases**; up to 10 only for a very large
change touching many independent features, which should be rare. Each case has

- `title`: what it checks, as a short sentence ("The counter increments on click");
- `steps`: what you will do on the desktop, one per line;
- `expected`: what must be true at the end, observable on a screenshot or in a
  terminal.

Cover the happy path the user asked for first, then the details they named
explicitly (labels, colors, error messages, keyboard shortcuts), then one
edge case if it matters. Register them with one call:

```
e2e_plan({ cases: [{ title, steps, expected }, ...] })
```

The result lists the cases with their numbers (1-based, in your order). Only one
`e2e_plan` per run.

## 3. Run

Bring the application into a testable state first (install, build, start the
server, open the browser): that is setup, not a case, and happens before
recording so the video stays short.

Then `start_recording` once for the whole run, and for each case in order:

1. `e2e_case_start({ index })` — the case's timer starts and the user's pane
   jumps to it.
2. `annotate_recording` with a caption like `Test 2: The counter increments on
   click` (test_start style), then before each meaningful step a caption
   saying what you do or what the screen shows; after checking the result, a
   caption with the verdict (`Assertion: counter shows 3 — passed`).
3. Do the steps with the desktop tools: `screenshot` first, `left_click`,
   `type`, `key`, `scroll`, `zoom` to read small text, `wait` for loads, a
   terminal or VS Code when the check needs one. Take a `screenshot` after the
   last step and compare it with `expected`.
4. Save the final screenshot for the record, for example with
   `import -window root /workspace/recordings/e2e-case-2.png` (ImageMagick) or
   `xwd`/`ffmpeg`, then
   `e2e_case_end({ index, status: "passed" | "failed", note, screenshot_path })`
   with a one-line note (what you saw; for a failure, what was wrong).

Use `skipped` for a case you cannot exercise at all (say why in the note).
One case runs at a time; end it before starting the next.

## 4. Fix and rerun

A failed case means the work of the turn is not done. Fix the code as you would
in a normal turn (edit, rebuild, restart what needs it), then rerun **the same
case** with `e2e_case_start({ index })` again: that opens a new cycle of it
(cycle 2, 3, ...), the earlier attempt stays in the record. Rerun any earlier
case your fix could have affected, too. Keep recording while you fix; a caption
like `Fixing: the button had no click handler` tells the user what is happening.

At most **3 fix attempts per case**. When a case still fails after that, leave
it failed with a clear note and move on; the user decides what to do next.

## 5. Finish

`stop_recording` (let it condense; pass the narration language you wrote the
captions in if not English), then

```
e2e_finish({ video_path: "<path from stop_recording>", summary: "<2–3 sentences>" })
```

The run's verdict is `passed` when no case's last attempt failed. End your
reply with one short paragraph: how many cases passed, which failed and why,
what you fixed, and the video's `/workspace/...` path written out so the user
gets the player in the chat. Do not paste the case list; the pane shows it.
