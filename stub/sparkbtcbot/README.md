# sparkbtcbot

Forwarder for [`sparkbtcbot-skill`](https://www.npmjs.com/package/sparkbtcbot-skill).

```
npx sparkbtcbot help
```

installs and runs the real Spark Bitcoin L2 wallet skill. Everything after the
command name is passed through unchanged, and the real CLI's exit code is
returned.

## Why this package exists

Two reasons, and the second changed in 0.2.0.

**Name ownership.** The short name is held by the project rather than by a
squatter. A `npx sparkbtcbot` that falls back to the registry lands on
project-owned code.

**It now works.** Through 0.1.0 this package *refused* — it printed
instructions and exited 1. That was fine for a wrong-directory `npx` fallback,
which is what it was written for, but it meant `npm install sparkbtcbot`
succeeded silently and the user found out only when they ran it, via a message
that blamed a cause that did not apply. Forwarding is the better outcome: the
short name does what someone typing it expects.

## The dependency is pinned exactly

`sparkbtcbot-skill` is pinned to an exact version, not a range. A range would
let `npx sparkbtcbot` resolve a skill build this forwarder has never been
tested against, at install time, into a process that handles seed material —
the unpinned-resolution problem this project's supply-chain rules exist to
prevent.

The cost is that this package needs a version bump and a `publish-stub` run to
track a new skill release. That is deliberate: a forwarder that silently
follows is worse than one that lags visibly.

Install the real package directly if you prefer:

```
npm install sparkbtcbot-skill
```
