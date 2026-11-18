# Whole-host Kind to K3s migration preparation

Date:2026-11-18. State: **in progress**. Source baseline:d5f9b9e97b491446ae0b7aa417cdac6e39c08ba0.
Execution mode:SINGLE_AGENT implementation, separate independent read-only review.
Skills:ops-cli-usage,ops-task-authoring,company baseline. This is an existing
migration-contract change, not a new HLD or an application change. Company
onboarding is available and has no feed changes. No governed CP session write
is attempted while this project's roster readiness is unassigned; local bounded
handoff/evidence is retained. No new infrastructure or operational authority.

## Approved sequence

| Phase | State | Contract and evidence required |
| --- | --- | --- |
|1. Modify and qualify the migrator | in progress | Stop the selected Kind container without stopping/disabling Docker. Explicit ordered external-container selection, original-state inventory, current daemon/source/target guards; focused local tests and independent review |
|2. Prepare recovery and stop source writers | not started | Operator-approved maintenance; suspend application ingress/jobs/sends, verify final consistent recovery generation, stop selected external containers in dependency order and Kind. Keep Docker service/socket available. Record originally stopped containers; no implicit activation |
|3. Install native K3s | not started | Exact qualified ARM64 artifacts, non-conflicting ports/networks, bootstrap-only target and unchanged local Docker daemon. No source deletion |
|4. Migrate OPS0.9.0 and restore | not started | Restore compatible platform definitions, users/credentials/ACLs, images and persistent data; inventory all other Kind workloads/PVCs. Preserve per-target identity, checksums and restore fences. Do not equate ordinary data backup with full installation migration |
|5. Verify technical restoration | not started | Required components healthy; data/volume/credentials/permission comparisons. Keep application writers/schedulers/sends suspended. No-access alone does not prevent background writes |
|6. Move Ollama to K3s | not started | Preserve existing model directory, validate GPU/runtime/access and selected model; old instance remains stopped. No model download or new inference profile |
|7. Reconnect retained Docker services | not started | Restart only explicitly retained and originally active services, in reviewed dependency order; stable private endpoints and current authorization, no duplicate bridge/reader/writer |
|8. Operator acceptance and activation | not started | Real functional checks, restart/backup verification and deliberate activation. Retain stopped Kind/recovery until acceptance. New target writes require reconciliation before any return to the old source |

## Bounded implementation contract

The existing public Kind route remains `ops migrate --to=k3s`. A protected
optional `OPS_HOME/migrate/host-services.json` selects exact external container
IDs in stop order and assigns retain-docker,move-to-k3s or keep-stopped. It is
not an environment variable or a deployment command. Unknown running containers,
missing/duplicate IDs, different daemon/source/image, changed inventory or an
unexpectedly restarted service fail closed. Capture only non-content identity,
original running state and disposition; never inspect environment values.

The migrator stops selected active external services then the exact Kind source.
It never starts containers, restores an old database, stops Docker, changes
restart policy, deletes source state or automatically rolls back. The inventory
provides a restart proposal; applying that proposal is a separate maintenance
phase. Originally stopped,move-to-k3s and Kind containers are not restart targets.

New root-owned installation/target proof carries a versioned source-runtime
binding. Verify it at target bind, restore preflight and each restore phase;
source identity must match the selected archive. Preserve existing v1 markers,
legacy daemon-off and isolated restore semantics. Do not silently upgrade an
old prepared target or reinterpret its code/checkpoint. Missing or malformed
new proof cannot fall back to weaker legacy checks. Empty-target, physical-host,
archive/checksum/capacity and immutable-code restrictions remain.

## Acceptance and open gates

Local tests must use synthetic IDs and mocked command executors only: no OPS,
Docker/systemctl/kubectl invocation, installer execution or download. Cover
read-only check, current plan drift, ordered stops/partial failure, source
restart, unauthorized running services, state/image changes, root proof binding,
old-marker behavior, restore fencing and no automatic restart/daemon shutdown.
Independent review freezes adversarial cases separately. Preserve failed runs
and correct them without changing their reported status.

This branch does not claim complete ARM64 catalog compatibility or a live
migration rehearsal. Previously reviewed AMD64-only catalogs and host/application
recovery gaps remain open. No catalog hash substitution, downloads, GPU setup,
Ollama move, live backup/restore, service stop, migration or application change
is authorized/executed by this development iteration. Publication and operational
acceptance are separate from local source qualification.

## Local implementation checkpoint

2026-11-18: implementation and author qualification complete; independent final
review pending. Native module/installer/target marker2 and restore-phase fences
implemented. The earlier design review froze18 independent adversarial cases
before edits (manifest digest3e74bcd5ef7a62308b04787764cbe9dc97637ef05b56125772ebaa1861d8694f).
Author suites:121migration +84restore distinct cases PASS, separately repeated
under Python optimized mode with the same counts; do not sum modes as distinct
coverage. Initial full-wrapper fixture lacked its synthetic snapshot field;
original failing result retained, fixture completed without relaxing runtime
checks. New tests cover ordered/partial stops, immutable evidence, plan drift,
root re-observation, marker binding and fresh-run refusal after a partial stop.
Existing valid v1 same-host/isolated contracts remain qualified by regressions.
Privacy and diff checks PASS; CLI/public options and dependency/catalog bytes
unchanged. No real host command or application change is part of these tests.

Source completion is not migration readiness. ARM64 catalogs, existing extra
Kind workloads/PVC inventory, GPU/Ollama, connectivity, activation fencing,
consistent final backup and operator-led rehearsal remain unexecuted/open.
