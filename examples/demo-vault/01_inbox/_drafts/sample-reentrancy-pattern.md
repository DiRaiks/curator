---
title: Reentrancy via callback in withdrawal queues
status: draft-from-agent
proposed_destination: 03_areas/patterns/reentrancy/callback-in-queue.md
reason: Observed in sample-project; same shape will appear in other queue-based contracts.
source_run: demo-2026-05-18
project: sample-project
created: '2026-05-18'
tags: [pattern, reentrancy, defi]
type: pattern
---

# Reentrancy via callback in withdrawal queues

When a withdrawal queue contract calls an external `onWithdraw` hook
**before** marking the request as fulfilled, the recipient can re-enter
and claim the same request twice.

## Why this matters

This shape recurs across staking / wq / vault contracts. Anywhere
state mutation lives after an external call, the same pattern applies.
Worth grepping for in any new audit target.

## Where this was first observed

Sample placeholder — replace with the real project + commit hash + run
id when reflecting on a real session.

## Detection checklist

- [ ] external call before state update?
- [ ] CEI ordering preserved?
- [ ] re-entrancy guard on the entry function?
- [ ] hook is not on a list of "trusted" callees (which is a separate
      smell)?
