# AI Session Coaching

## Why this matters

The replay already shows what an agent did. Coaching should explain where the
session lost time, how the agent recovered, and what could make the next run
better.

This direction is inspired by Lucas Meijer's talk
["A love letter to Pi"](https://www.youtube.com/watch?v=fdbXNWkpPMY). The useful
loop is:

1. inspect the complete session;
2. find a detour that was later corrected;
3. identify the missing repository or workflow context;
4. change the environment so the next session rolls more smoothly.

This is different from judging only the final diff. A successful session can
still contain an expensive or repeatable wrong turn.

## Research takeaways

- Claude Code's `/insights` analyzes many sessions, classifies friction, and
  turns recurring patterns into workflow and instruction suggestions.
- Pi's tree-based sessions make abandoned branches visible. A branch can be
  discarded when it is noise or summarized when it contains a useful lesson.
- Pi's `pi-session-analyzer` treats historical sessions as structured data with
  summaries, timelines, branches, audits, and takeover reports.
- The 2026 study
  ["How Coding Agents Fail Their Users"](https://arxiv.org/html/2605.29442v1)
  found that misalignment is usually visible through developer correction or
  pushback. It also found that single-pass extraction produces unsupported
  claims often enough to require a separate evidence-validation pass.

The product implication is that a coach must be evidence-first. It should not
call every failed command a wrong turn, infer silent dissatisfaction, or
present a one-session hypothesis as a recurring repository problem.

## Current implementation

AI Coach now asks for two separate kinds of output:

- **Recoverable wrong turns** — a detour scene, a later recovery scene, at least
  two evidence scenes, an explanation, a better route, and a confidence level.
- **Suggested repo additions** — a target such as `AGENTS.md`, a test, a
  validation script, a hook, or a skill; draft content or behavior to add; a
  verification step; and scene evidence.

The transcript digest labels assistant scenes explicitly, and deterministic
signals mark possible tool failures and user corrections before the model
analyses the session. The model still has to verify those signals; they are
not findings by themselves.

The Coach also receives an incomplete summary of paths, instruction files, and
commands that were actually visible in the session. This keeps recommendations
concrete without giving the model filesystem access or allowing it to invent
the current repository state.

Invalid scene references, out-of-order recovery claims, and recommendations
without evidence are discarded. Findings are written as replay annotations at
the detour scene, while the session summary includes the prevention plan,
next-session checklist, and analysis limitations.

The Coach remains read-only. It does not edit the repository, run commands, or
turn a speculative recommendation into an automatic rule.

## Next product step

The next useful layer is cross-session coaching:

- persist a structured coaching run with a replay fingerprint;
- compare findings across sessions in the same project;
- distinguish a first-time lesson from a regression;
- suggest the smallest enforcement mechanism: documentation, a test, a
  validation script, a hook, or a skill;
- ask the user to approve each proposed repository change.

That layer should be built after the single-session evidence path has enough
real examples to evaluate precision. The success metric is not the number of
findings; it is whether the next comparable session avoids the detour.
