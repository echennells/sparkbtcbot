# Supply-chain hardening of the npm install

Load when **you (the agent) are about to run `git clone … && npm install` on the user's behalf** — that is the only case this applies to. It does not apply to the Claude plugin path or to a user installing the npm package themselves.

## Offer it — ONLY when *you* run the install

This skill owns the **when**, not the settings. It applies in exactly one case: **you (the agent) are running `git clone … && npm install` on the user's behalf** (npm pulls ~160 transitive deps — a real supply-chain surface). It does **not** apply to the Claude plugin path (`plugin marketplace add` / `plugin install` — no dependency install to harden) or to a user running `npm install sparkbtcbot-skill` themselves (their own tooling — out of scope, don't touch it).

In that one case, **ask the user before installing** whether they want npm supply-chain hardening on this install, and offer two ways to apply it:
- **Persistent** — write the hardening to their `~/.npmrc` (affects all future npm use; get explicit consent since it modifies their profile).
- **Ephemeral** — the same keys as `NPM_CONFIG_*` environment variables on just this `npm install` (no files written).
- Or **neither** — a plain `npm install`.

**The settings themselves are NOT defined here — the source of truth is the [`echennells/supply-chain-hardening`](https://github.com/echennells/supply-chain-hardening) repo.** Read its npm config there — the template is `templates/npmrc.j2` (system-wide: `templates/etc-npmrc.j2`), values in `defaults/main.yml`; there is no `.npmrc` at the repo root — and apply those keys/values (they are version-sensitive — e.g. npm's `min-release-age` package cooldown only enforces on npm ≥ 11.10.0; `ignore-scripts` can break native-build deps though it is fine for this skill's pure-JS tree). Do not hard-code or invent a recipe here; if the user already has their own `~/.npmrc` policy, follow it instead of overriding.

**npm version is best-effort, not a gate.** Prefer npm 12+ (disables install scripts by default), accept 11.10.0+ (the age-gate floor), and on older npm **proceed anyway** — tell the user the cooldown won't enforce and lean on `npm ci`/lockfile hardening. **No Node bundles npm 12** (Node 22.x LTS ships npm 10.x): meeting its engines floor (Node 22.22.2+/24.15+; the wallet itself needs only >=20) makes the upgrade possible, not automatic — `npm install -g npm@latest` (needs `sudo` or a user prefix/nvm on system-wide installs), then `npm --version` to confirm. No Node at all → install a current LTS from an official channel; provisioning detail is the hardening repo's job, don't improvise piped-to-root installers. Never block or refuse wallet setup over the npm version; it only hardens the dependency install, not the wallet.
