# Spikes

Short, time-boxed experiments that settle an **Open** or **Default** choice with evidence. One file per spike, named `<task>-<topic>.md` (for example `t08-sandbox.md`). Spike code can be thrown away; the write-up stays.

## Template

```markdown
# <Task>: <question>

**Date:** YYYY-MM-DD · **Time box:** N days · **Decision entry:** D-0xx

## Question

One sentence: what are we choosing between, and why now?

## Criteria

Copied from decisions.md, with target numbers.

## Options tried

| Option | Version | Setup notes |

## Results

| Criterion | Option A | Option B | Option C |
Measured numbers, device or machine used, how measured.

## Recommendation

The choice, the main reason, and what we give up.

## Follow-ups

Status change in decisions.md and tech-stack.md; inventory entry if a WASM library was chosen; tasks affected.
```

## Planned spikes

| Spike                     | When             | Decides                                       |
| ------------------------- | ---------------- | --------------------------------------------- |
| `t08-sandbox.md`          | Start of T08     | Server sandbox for game code (D-008)          |
| `t13-renderer-2d.md`      | Start of T13     | 2D table renderer (D-009)                     |
| `phase2-physics.md`       | Start of Phase 2 | Physics engine and dexterity approach (Q-004) |
| `phase2-asset-formats.md` | Phase 2          | Texture and model formats                     |
