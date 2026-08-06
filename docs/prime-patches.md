# Prime Agent patches

Deck pins Prime Agent 0.7.0, but Prime is still young and fixes needed by long-running Deck seats can land faster than an upstream release. Deck therefore carries a small, explicit patch set instead of relying on a developer's `~/work` checkout. The source patches, their upstream state, and the exact installable artifact live in `patches/prime-agent/`.

`manifest.json` is the source of truth. It binds every patch to its source commit and upstream branch, binds the base to Prime 0.7.0 at commit `be9e2fa0714e7cd1c6bd9bdb1b554d2cc6550387`, and records SHA-256 fingerprints for the patches and reviewed tarball. The tarball is checked into Deck so laptop, deckbox, and CI install the same bytes; they do not rebuild Prime against moving model catalogs or dependencies.

## Check or install the patch set

Use the same commands on a laptop or deckbox, with the npm/NVM environment that owns the active `prime-agent` command:

```sh
cd ~/dev/deck
./ops/prime-patches.sh status
./ops/prime-patches.sh apply
./ops/prime-patches.sh verify
```

`status` is read-only. It distinguishes the pristine 0.7.0 package from Deck's patched 0.7.0 package by hashing the installed package tree, not by trusting `prime-agent --version`. It also asks `gh` for the current state of upstream PRs. A missing `gh` login is reported as unavailable without hiding the local fingerprint.

`apply` accepts only the reviewed pristine tree or the already-patched tree. It refuses another Prime version and any dirty or unknown package tree. It verifies the vendored tarball, installs it through npm, writes `.deck-prime-patches.json` beside the package, and verifies the result. Re-running it is safe.

`verify` exits non-zero for a pristine, dirty, unknown, or wrong-version install. The marker records the manifest and individual patch hashes, while the manifest's package-tree and CLI hashes provide the deterministic check against the installed bytes.

For CI, first install the reviewed pristine artifact into an isolated npm prefix, then apply the same vendored patch artifact:

```sh
prefix="$RUNNER_TEMP/deck-prime"
base="$RUNNER_TEMP/prime-agent-0.7.0.tgz"
curl -fsSL https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.0/prime-agent-0.7.0.tgz -o "$base"
printf '%s  %s\n' 88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b "$base" | shasum -a 256 -c -
npm install --global --prefix "$prefix" "$base"
PRIME_PATCH_NPM_PREFIX="$prefix" ./ops/prime-patches.sh apply
PRIME_PATCH_NPM_PREFIX="$prefix" ./ops/prime-patches.sh verify
printf '%s/bin\n' "$prefix" >> "$GITHUB_PATH"
```

`PRIME_PATCH_NPM_PREFIX` is the supported way to target a non-default install. `PRIME_AGENT_BIN` and `PRIME_AGENT_ROOT` are read-only overrides for `status` and `verify`; `apply` rejects them so it cannot accidentally install into a different npm prefix.

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

   Use `local-only`, null PR fields, and a `-wip.patch` file name in the manifest. Do not commit, reset, stash, or otherwise alter the source worktree merely to capture it.
4. Add the manifest record: short name, one-sentence fix, PR number and URL or null, upstream branch, full source commit SHA, base version, status, file name, and patch SHA-256.
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
7. Exercise `status`, `apply`, and `verify` against an isolated npm prefix before committing. Also confirm `apply` is idempotent and rejects a modified package tree.

## Drop a patch after upstream merges

`status` reports each PR as open, closed, or merged. A merge alone is not enough to remove a patch: Deck's pinned release must contain the merged fix. When the PR merge commit is an ancestor of the pinned commit, `status` prints `REMOVABLE`.

To remove it:

1. Advance Deck's reviewed Prime version, commit, and pristine artifact together so the new pin includes the fix.
2. Remove the patch file and its manifest record.
3. Reapply the remaining patches to the new pin, rerun their focused tests, and replace the vendored patched tarball and all recorded hashes.
4. Install into an isolated prefix and run `status`, `apply`, and `verify` before changing laptop, deckbox, or CI.

Never retain an upstreamed patch indefinitely, and never drop one merely because a PR says merged while Deck still pins an older release.

## Seat adapter hook

The workflow seat must run patch verification immediately after its existing `prime-agent --version` assertion and before any daemon or seat process starts. In `workflows/pr-pipeline/lib/engines/prime.ts`, call `ops/prime-patches.sh verify` at the end of `verifyVersion()`, using the same sanitized environment plus `PRIME_AGENT_BIN: binary`. A non-zero result should raise `PrimeSeatError` with `PRIME_VERSION_MISMATCH` and include the verifier's stderr. Resolve the script with `fileURLToPath(new URL("../../../../ops/prime-patches.sh", import.meta.url))`; do not depend on the process working directory.
