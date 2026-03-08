# Test Suite — Modification Policy

## Why this policy exists

These tests protect **parser compatibility** with real-world session data from Claude Code and Cursor. The session format evolves over time, but old sessions must remain parseable forever. Tests encode real observed behavior — they are **contracts, not implementation details**.

## Rules for AI agents (Claude, Cursor, Copilot, etc.)

1. **NEVER delete or weaken a test to make code changes pass.** If a test fails after your code change, the code is wrong — not the test. Fix the code.

2. **NEVER change assertion values in existing tests.** Test values are derived from real session data or deliberate security contracts. Changing `expect(x).toBe("foo")` to `expect(x).toBe("bar")` silently breaks backward compatibility.

3. **NEVER convert a strong assertion to a weak one.** Examples of weakening:
   - `toBe("exact value")` → `toBeDefined()` or `toContain("partial")`
   - `toHaveLength(3)` → `toBeGreaterThan(0)`
   - Removing an `expect()` from a test
   - Wrapping `expect()` in `if` conditions that might be false

4. **Adding new tests is always OK.** But don't add tests that duplicate existing coverage — check first.

5. **If a test truly needs updating** (e.g., the parser intentionally changes behavior), you MUST:
   - Explain which user-visible behavior changed and why
   - Confirm the old format is still supported (backward compatibility)
   - Add a new test for the new behavior, keep the old test if old format still works
   - Get explicit human approval before modifying the test

## Test file organization

| File | Purpose | Canonical for |
|------|---------|---------------|
| `claude-code-parser.test.ts` | Core parser behavior | Parse correctness |
| `claude-code-parser-comprehensive.test.ts` | Multi-file, edge cases, integration | Parser + transform integration |
| `claude-code-real-world.test.ts` | Real-world patterns from actual sessions | Format compatibility |
| `transform-comprehensive.test.ts` | Scene generation, tool enrichment, costs | Transform logic |
| `transform-security.test.ts` | Path + secret redaction | **Security (do not weaken)** |
| `cursor-parser.test.ts` | Cursor JSONL parsing | Cursor format |
| `cursor-parser-comprehensive.test.ts` | Cursor edge cases | Cursor compatibility |
| `cursor-sqlite.test.ts` | SQLite reader + fallback logic | SQLite parsing |
| `cursor-thinking-merge.test.ts` | Thinking block merge algorithm | Merge correctness |
| `clean-prompt.test.ts` | Prompt cleaning | Text cleanup |
| `scan.test.ts` | Secret scanning patterns | **Security (do not weaken)** |

## Fixture files

Fixture JSONL files in `fixtures/` represent **real session data formats**. Do not modify existing fixture values — add new fixtures for new format versions. The `claude-code-real-world-edges.jsonl` fixture was built from actual production session analysis.

## Anti-patterns to avoid

```typescript
// BAD: if-guard hides assertion failure (test passes vacuously if condition is false)
if (scene.type === "tool-call") {
  expect(scene.diff).toBeDefined();
}

// GOOD: explicit type assertion followed by direct property access
expect(scene.type).toBe("tool-call");
expect(scene.type === "tool-call" && scene.diff).toBeDefined();

// GOOD: extract with assertion
const s = scene as Extract<Scene, {type: "tool-call"}>;
expect(s.diff).toBeDefined();
```
