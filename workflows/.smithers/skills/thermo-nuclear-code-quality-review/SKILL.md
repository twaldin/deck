# Thermo-nuclear code quality review

Perform a hostile, evidence-based quality review of the exact PR head.

- Inspect the complete diff and all affected call paths. Do not review a summary alone.
- Check state machines, stale snapshots, ordering, retries, idempotency, races, resource bounds, and partial failures.
- Check security boundaries, input validation, secrets, permissions, subprocess arguments, and destructive side effects.
- Check API and schema compatibility, migration and recovery behavior, observability, and operational failure modes.
- Run the smallest relevant tests, then identify tests that would pass on the old code or do not exercise runtime behavior.
- Verify that reported SHA, checked SHA, and final SHA are identical. Re-read after any repair or rebase.

Return JSON only with concrete findings. Include severity, file and location, impact, trigger, evidence, and a fix direction. Never edit, commit, push, approve, or merge. Never run GitHub approval commands.
