# Prime Agent patches

Deck pins Prime Agent 0.7.0, but Prime is still young and fixes needed by long-running Deck seats can land faster than an upstream release. Deck therefore carries a small, explicit patch set instead of relying on a developer's `~/work` checkout. The source patches, their upstream state, and the exact installable artifact live in `patches/prime-agent/`.

`manifest.json` is the source of truth. It binds every patch to its source commit and upstream branch, binds the base to Prime 0.7.0 at commit `be9e2fa0714e7cd1c6bd9bdb1b554d2cc6550387`, and records SHA-256 fingerprints for the pristine install, source patches, and reviewed patched tarball. The tarball is checked into Deck so every machine can install the same bytes if patched mode is approved; no machine rebuilds Prime against moving model catalogs or dependencies.

## Check the expected install

The captain's current policy is a pristine Prime Agent 0.7.0 install. The three
carried fixes are recorded for recovery and upstream tracking, but are
`not-applied`. Use the same read-only checks on a laptop or deckbox, with the
npm/NVM environment that owns the active `prime-agent` command:

```sh
cd ~/dev/deck
./ops/prime-patches.sh status
./ops/prime-patches.sh verify
```

`status` distinguishes pristine, patched, partial, and unknown installs using
the package-tree fingerprint plus a compiled-file and bundle probe for each
patch. It does not trust `prime-agent --version`. It also asks `gh` for the
current state of PRs 682, 677, and 675. A missing `gh` login or failed ancestry
query is reported as unavailable rather than guessed.

`verify` enforces `expectedInstallState` from the manifest. Today it exits zero
only for the exact pristine 0.7.0 package tree and CLI; patched, dirty, unknown,
wrong-version, incomplete, and non-executable installs fail.

`apply` remains available if the captain later chooses the reviewed patched
artifact. That policy change must first set `expectedInstallState` to `patched`
in a reviewed manifest commit. Until then, `apply` refuses without touching the
install. When enabled, it accepts only the reviewed pristine or already-patched
tree, verifies and overlays the vendored package files without re-resolving npm
dependencies, writes `.deck-prime-patches.json`, and verifies the result.

For CI, install and verify the reviewed pristine artifact in an isolated npm
prefix:

```sh
prefix="$RUNNER_TEMP/deck-prime"
base="$RUNNER_TEMP/prime-agent-0.7.0.tgz"
curl -fsSL https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.0/prime-agent-0.7.0.tgz -o "$base"
printf '%s  %s\n' 88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b "$base" | shasum -a 256 -c -
npm install --global --prefix "$prefix" "$base"
PRIME_PATCH_NPM_PREFIX="$prefix" ./ops/prime-patches.sh status
PRIME_PATCH_NPM_PREFIX="$prefix" ./ops/prime-patches.sh verify
printf '%s/bin\n' "$prefix" >> "$GITHUB_PATH"
```

`PRIME_PATCH_NPM_PREFIX` targets an isolated install. `PRIME_AGENT_BIN` and
`PRIME_AGENT_ROOT` are read-only overrides for `status` and `verify`; `apply`
rejects them so it cannot install into a different npm prefix.

## Add a patch

1. Start from the Prime commit pinned in `manifest.json`. Keep the upstream fix as one narrow commit when possible.
2. Capture a committed fix without changing its worktree:

   ```sh
   git -C /path/to/prime-worktree format-patch \
     --no-signature --zero-commit --full-index --binary -1 <commit-sha> \
     --output-directory "$PWD/patches/prime-agent"
   ```

   Rename the result to `patches/prime-agent/<short-name>.patch`. Full blob IDs let `git apply --3way` carry a fix from its upstream merge base onto the pinned release.
3. For work that has not reached an upstream PR, take a read-only WIP snapshot instead:

   ```sh
   git -C /path/to/prime-worktree diff --binary --full-index --no-ext-diff \
     --output="$PWD/patches/prime-agent/<short-name>-wip.patch"
   ```

   Use a `-wip.patch` file name while no PR exists. Once a PR opens, record its
   number and URL and change the status to `upstream-open`; the WIP file name can
   remain as capture history. Every carried patch stays `not-applied` while the
   manifest expects pristine. Do not commit, reset, stash, or otherwise alter
   the source worktree merely to capture it.
4. Add the manifest record: short name, one-sentence fix, PR number and URL,
   upstream branch, full source commit SHA, base version, status, application
   policy, file name, source patch hash, and installed detection values.
5. In a disposable clone at the pinned base commit, apply every source patch with `git apply --3way`, resolve overlapping release-note hunks without dropping either note, run `git diff --check`, and run the focused upstream tests for every fix.
6. Build and pack Prime once in that reviewed clone:

   ```sh
   npm ci
   npm run build
   node scripts/pack-prime-agent-release.mjs \
     --base-url https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev \
     --version 0.7.0
   ```

   Copy `packages/coding-agent/release/artifacts/prime-agent-0.7.0.tgz` to `patches/prime-agent/prime-agent-0.7.0-deck-patched.tgz`. Update its archive, package-tree, and CLI SHA-256 values in the manifest. The checked-in artifact, not a later rebuild, is what all machines install.
7. In an isolated Deck checkout, temporarily set `expectedInstallState` to
   `patched` and exercise `status`, `apply`, and `verify` against an isolated npm
   prefix. Confirm idempotence and dirty-tree refusal, then restore the reviewed
   policy value before committing.

## Drop a patch after upstream merges

`status` reports each PR as open, closed, or merged. A merge alone is not enough to remove a patch: Deck's pinned release must contain the merged fix. When the PR merge commit is an ancestor of the pinned commit, `status` prints `REMOVABLE`.

To remove it:

1. Advance Deck's reviewed Prime version, commit, and pristine artifact together so the new pin includes the fix.
2. Remove the patch file and its manifest record.
3. Reapply the remaining patches to the new pin, rerun their focused tests, and replace the vendored patched tarball and all recorded hashes.
4. Install the new pristine pin into an isolated prefix and run `status` and
   `verify` before changing laptop, deckbox, or CI. Exercise `apply` only if the
   reviewed manifest policy is `patched`.

Never retain an upstreamed patch indefinitely, and never drop one merely because a PR says merged while Deck still pins an older release.

## Seat adapter hook

The workflow seat must run patch verification immediately after its existing `prime-agent --version` assertion and before any daemon or seat process starts. In `workflows/pr-pipeline/lib/engines/prime.ts`, call `ops/prime-patches.sh verify` at the end of `verifyVersion()`, using the same sanitized environment plus `PRIME_AGENT_BIN: binary`. A non-zero result should raise `PrimeSeatError` with `PRIME_VERSION_MISMATCH` and include the verifier's stderr. Resolve the script with `fileURLToPath(new URL("../../../../ops/prime-patches.sh", import.meta.url))`; do not depend on the process working directory.
