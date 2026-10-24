# Everything else from the 2026-10-24 rescue

The second pass: "keep all of it". Every file in the old session scratchpads is
now either on a branch, in the gitignored `temp/rescued-secrets-2026-10-24/`
on the host, or listed below as third-party / regenerable.

## Where things went

| What | Where |
|---|---|
| x402 payer prototype | `wip/x402-lnbtc-payer` |
| token-guards e2e harness + eval outputs | `wip/token-guards-e2e` |
| treasury drafts | `wip/companion-treasury-drafts` (held) |
| the 10-04 unshelve port, every step and repo copy as patches | `archive/unshelve-port-2026-10-04` (held: carries a security PoC) |
| the companion / phone-wallet session scratchpad, GitHub API dumps | `archive/companion-scratch-2026-10` (held) |
| loose leftovers, round 1 | this branch, `README.md` |
| the rest of the 09-25/26 x402 / L402 / MPP session | this branch, `x402-l402-session/` |
| the scripts used for the rescue itself | this branch, `rescue-tools/` |
| seeds, passphrases, pairing state, captured L402 challenges, service logins | host only: `temp/rescued-secrets-2026-10-24/` |

`x402-l402-session/`: `policy.backup.js` and `spark-agent.backup*.js` are
mid-work copies of `lib/policy.js` and `spark-agent.js` from the 09-26 host-gate
work (in no commit); `rep.py` is the exact-replace edit helper;
`mpp-dryrun/package.json` is an empty MPP client trial. `agent-class.HEAD.md`
is identical to `skills/sparkbtcbot/references/agent-class.md` at `5050486`,
so it isn't repeated.

`rescue-tools/`: balance check and sweep (no secrets; the destination is an
argument), the secret scanner (BIP39-run + credential patterns), and the
snapshot tools (`snapmatch.sh` finds the commit a repo copy came from,
`mkpatch.sh` / `verifypatch.sh` write and round-trip the port patches,
`unsaved.sh` lists files whose content is in no commit).

## Third-party, not copied (re-fetch from the source)

- x402 specification documents (core v2, HTTP and MCP transports, the
  `auth-hints` and `sign-in-with-x` extensions, `scheme_exact_lnbtc.md`) —
  github.com/x402-foundation/x402, `specs/`.
- The x402 Python `lnbtc` draft — x402-foundation/x402 pull request #1873.
- The 2026-09-24 x402 Foundation announcement page —
  block.xyz/inside/block-joins-the-x402-foundation-to-advance-open-agentic-commerce.
- A Python multi-rail 402 client, read for comparison —
  github.com/nikoSchoinas/routeweiler-python-sdk.
- satring.com API responses (about, API, llms.txt, OpenAPI, spec,
  `.well-known/l402`), fetched 2026-09-26.
- MPP / MPPScan `llms.txt` and the MPPScan service registry
  (`api-services.json`, `services.ts`, `services.html`), fetched 2026-09-26.
- `macgen/py`: pip packages `pymacaroons==0.13.0`, PyNaCl, `cffi==2.1.1`,
  `pycparser==3.0`.
- github.com/open-wallet-standard/core at `2ab11a0` (unmodified clone, 10-10).
- github.com/austintgriffith/ethevals at `314da16` and
  github.com/austintgriffith/ethskills at `06ea4ef` (unmodified clones, 09-25),
  and a copy of the latter's wallets skill.
- The companion session's npm packages and Apple's APNs pages: listed in
  `archive/companion-scratch-2026-10/README.md`.

## Regenerable, not kept

`node_modules` everywhere; `companion-export/` (an Expo web export of the
companion app); local `.wrangler/` state; the vitest suite's ~21,000 leftover
temp folders in `/tmp`.
