# Whole-host Kind to K3s migration preparation

Date:2026-11-18. State: **in progress — Kind-only source completed; ARM64 preparation in progress; operational phases not started**. Source baseline:d5f9b9e97b491446ae0b7aa417cdac6e39c08ba0.
Execution mode:SINGLE_AGENT implementation, separate independent read-only review.
Skills:ops-cli-usage,ops-task-authoring,company baseline. This is an existing
migration-contract change, not a new HLD or an application change. Company
onboarding is available and has no feed changes. No governed CP session write
is attempted while this project's roster readiness is unassigned; local bounded
handoff/evidence is retained. No new infrastructure or operational authority.

## Approved sequence

| Phase | State | Contract and evidence required |
| --- | --- | --- |
|1. Modify and qualify the migrator | in progress (Kind-only source completed; native ARM64 pending) | Stop the selected Kind container without stopping/disabling Docker. Explicit ordered external-container selection, original-state inventory, current daemon/source/target guards; focused local tests and independent review |
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

## Initial author checkpoint (retained evidence)

2026-11-18: initial implementation/author qualification completed; the following
independent durability review required the correction recorded below. Native module/installer/target marker2 and restore-phase fences
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

### Independent durability correction

Exact0133b43a review HOLD retained:18frozen independent controls and46focused
replays PASS, but the shared legacy save helper lacks parent-directory fsync.
Supplemental3crash/durability controls frozen before correction, digest
1f93dfba745dce55af7c22679093c04c1e8758f835afb7b456eb21380aacc465.
A migrator-only durable_save now preserves original file fsync and synchronizes
both the rename directory and its parent before returning. Journal/current
persistence covers newly created run/migrate entries before the first stop.
Any sync error prevents later phases; failure reporting is best-effort without
claiming unavailable evidence. The shared legacy store helper remains byte-exact.
Additional tests qualify file/rename/both-directory ordering and injected sync
failure with zero host commands. The updated immutable review is qualified below.

## Current development qualification

Phase1 completed on immutable runtime source2c319fb1f86b0a5cfa2dfdb525c51c481b703048.
Author123migration +84restore distinct cases PASS in normal and optimized Python
modes (207distinct cases; modes are not additional coverage). Independent frozen
18plus supplemental3 controls PASS in both modes, and48focused replay tests PASS;
these overlap author coverage and are not added into an artificial grand total.
Independent source GO receipt digest
3398bd70d30f1723b9203680e75e01584a272ad8d9d22702da2098394c5d2262.
Original0133b43a HOLD, all passing prior evidence and initial fixture failure
remain retained. Legacy store helpers and profile validation are byte-exact;
application checkout, dependencies/catalogs and public CLI unchanged.

This final follow-up changes documentation only. Publish the separate
codex/migrate-kind-only-docker-preserved branch; do not merge main or execute
migration. Phases2..8 remain not started, including maintenance/backup/stop,
ARM64 target qualification, full Kind add-on recovery, GPU/Ollama, network/service
reconnection and operator acceptance. No service stop, installer, OPS command,
backup/restore, dependency download or application mutation occurred in this
iteration. No live migration readiness claim follows from synthetic tests.

The task-owned private evidence directory retains onboarding, exact source and
test/review receipts until this branch's operational handoff/qualification ends.
Synthetic test directories are automatically removed. No shared cache, unrelated
private data or previous recovery material is deleted. Source bytecode cache
entries with unknown prior ownership are left untouched; no operational payload
was stored in them by these tests.

## ARM64 follow-up — blocked native qualification2026-11-18

Operator authorizes ARM64 qualification and preparation of complete-path checks,
without migration/service stop/application changes. The offline identity audit
and [complete-path matrix](arm64-full-path-checks.md) are qualified on this
same branch as offline identity checks only. Existing AMD64 operational catalogs and all source/restore guards
remain unchanged. The exact metadata-only batch24800d78 is explicitly approved and completed;
no binary/layer download, installation or implicit new client/catalog selection. The previous
phase1source qualification remains valid, not a native ARM64 acceptance claim.

ARM64 current gate:BLOCKED. All49image metadata roots/configs inspected;45have
verified ARM64 configurations and4selected immutable configurations are AMD64
(custom migration operator and legacy .NET2.2/Ruby2.5/Rust1.34). Official native
tool/wheel metadata proposals are recorded without downloading bytes. Source
39709c5f audit has independent18/18GO and author225distinct normal/optimized
checks PASS. Operational catalogs/guards/engine/application remain unchanged.
Full-path checks are prepared but not executed; artifacts, native source port,
full-host recovery and maintenance remain future gates. See the linked findings
and matrix; do not interpret offline audit GO as ARM migration readiness.

Independent metadata closeout GO on5ab691d3 (receipt154c2cd8), confirming all49
original roles/143JSON observations and all5upstream native input proposals.
The current result remains BLOCKED for native ARM64 migration. Source39709c5f
and operational predecessor7a2d294 are unchanged by this documentation closeout.

## ARM64 artifact and restore-path iteration — 2026-11-18

State: **completed for bounded preparation; native migration remains blocked**. Operator explicitly requests the missing ARM64 artifacts
and restore-path preparation on this dedicated branch. Acquire only the five
nativeArtifactProposals already fixed by upstream metadata; validate original
bytes and bounded unpacking, without installation/execution or dependency
fallbacks. Four immutable image roots and target OPS/Bun remain unqualified;
no replacement version, image deletion or emulation is implicit.

| Work | State | Acceptance |
| --- | --- | --- |
| Five pinned native inputs | completed (byte identity only) | Original SHA/size, bounded extraction, ARM64 ELF or every wheel member; no native execution |
| Explicit architecture/path propagation | completed (preparation only; native route blocked) | Legacy schema1 remains AMD64; prepare helpers and call sites without enabling an unqualified ARM64 operational route |
| Independent review | completed (GO preparation only) | Frozen24 cases, manifest6293c6713f27dc64110a0a883f85ae31168c7a63dffb14d7d607400894acf510 |
| Native catalog, CLI and full rehearsal | blocked | Four selected AMD64 images, untrusted target OPS/Bun and complete native qualification still required |

Existing installation/target marker2 binds sourceRuntime, not architecture. Do
not reinterpret it. New ARM64 persisted profiles/markers need a separately
complete versioned contract after native catalog qualification. This iteration
prepares reusable explicit platform paths while existing operational AMD64
profile and target gates remain closed. No migration, stop, restore, application
change or live qualification is authorized here.

### Author verification and retained limitations

All five authorized original native downloads and bounded offline ELF/wheel
checks PASS;109278086download bytes, no execution/installation. Extracted Restic
and Milvus hashes are recorded as archive-anchored observations. Native tooling
remains mode0600 in the task-private stage. Test160migration +84restore cases
PASS in normal and optimized Python; modes are not additional distinct coverage.
A real synthetic OCI ARM64 archive passes the expansion verifier and fails when
selected as AMD64. Six Bun unit tests PASS; one real OPS dispatch case is skipped
because no target OPS binary is qualified/authorized for execution here.
Twenty-six focused worker regressions PASS.

The broader49-case worker suite has5failures/6errors in root-ownership/protected
directory fixtures. The exact same11case IDs and error categories reproduce
using predecessor69a97f57 worker bytes in memory. Do not report that suite green
or use these existing environment-dependent failures as native qualification.
The original failing author OCI assertion is retained privately: it expected a
platform field that the canonical storage summary does not expose. The corrected
assertion checks real root/allocation proof and opposite-architecture rejection;
canonical engine/runtime guards were not changed to satisfy it.

Current catalog, installer, profile validator, root installation/target guards
and generated backup engine are byte-exact against69a97f57. Application main is
unchanged at56782562a62351b9eb773b4543fac8493ad149af and clean. No OPS, migration,
service control, live backup/restore or application operation was executed.
Independent final immutable-source review remains pending at this checkpoint.

The documentation/data/new-module privacy scan passes. Applying the Veryta
document regex to all pre-existing worker source lines also matches compact
Python inequality/colon syntax, not Matrix identifiers. These source hits were
inspected; no operational or customer identifiers were introduced. Preserve
that diagnostic instead of altering unrelated worker code to suppress it.

### Independent preparation closeout

Exact source9bfbbd843ce3e6f12c16d2289b37e2f1a5a3d94c received independent
**GO for artifact/source preparation only**. Receipt SHA256
e1616885157ff2534cad7b838950a9661c68cad760b12df029405655302f69e6.
Frozen24preparation/negative/default/path controls PASS normal and optimized
(same24, not48);19focused author cases independently replayed PASS. All five
original input SHA/sizes, extracted Restic/Milvus ELF and inner hashes, two
PyMongo ARM64 native members and neutral dnspython were independently verified
without execution. Nine current provenance hashes match; historical proofs and
all original operational catalog/profile/target/engine fences remain unchanged.

Two initial independent harness assertion errors were corrected and retained:
legacy boolean-schema behavior was overasserted outside the new source-owned
platform gate, and a guessed refresh error string was replaced with the actual
worker-delta denial oracle. No source was changed to satisfy these assertions.
The11broader worker failures remain disclosed and are not claimed green.

This documentation-only closeout preserves reviewed runtime source9bfbbd84.
Publish the dedicated branch only; do not merge main. Positive versioned ARM64
profile/archive/root-marker lifecycle, target OPS/Bun and four native image
replacements, native ABI and complete isolated rehearsal remain BLOCKED/NOT_RUN.
The already downloaded configs provide no immutable revision label for the
three legacy runtime source images; native replacement provenance still needs
to be established, not guessed from a mutable nightly tag. This observation
does not establish that compatible native variants are unavailable.

One task-private artifact area retains original inputs, verified non-executable
files, download/review receipts and minimal passing/original-failure evidence
until native qualification and accepted handoff (or cancellation). Synthetic
fixtures auto-clean; no shared cache, service, model or application data is
removed. Native byte identity, published source and migration readiness remain
separate results. Operational phases2..8 are still not started.

## Four-image and CLI native resolution — 2026-11-19

State: **in progress** on the existing dedicated branch, base730d1546edabd1cbb66b74d66a72adc75a87a513.
Operator scope: resolve the four native image blockers and qualify OPS/Bun;
focused tests and independent review, no migration/service stop/application change.
Execution mode:SINGLE_AGENT implementation plus independent read-only QA.
The company change feed is empty; existing contracts and operational gates apply.

| Work | State | Acceptance |
| --- | --- | --- |
| Freeze native provenance/compatibility cases | completed | Independent26case manifesteeaa6528a76e9e1a3203456744559724b5542c58dbe5fdfd2446b539a5da75f2 |
| Acquire upstream provenance | completed | Approved request 053ee99168b7b5c5f0c0455f57af8a6dc34bd3f2e72791cd242c9a13b9840b80. 9 initial responses, 3 additional trees and 28 blobs. All 40 responses (839,892 bytes) match the stored receipt. All 28 blob bindings were reverified offline. |
| Establish target CLI/Bun identities | in progress | Exact CLI source b889360d27f1 inspected. Its go.mod declares Go 1.22.5. Determine the exact Go toolchain or official CLI artifact and verify Bun in the same isolated target profile before native execution. |
| Resolve operator and three legacy runtimes | in progress | Operator source 4a325f729690 and legacy .NET, Ruby and Rust recipe candidates inspected. Native base manifests, layer closure and runtime compatibility are open. |
| Native compatibility checks | blocked | Review dispatch before any OPS execution; no-network temporary home/profile without actual host credentials/socket; no fallback to unconfined execution |
| Final review | not started | Exact immutable six-role evidence and source review, preserving deferred operational gates |

Local Bun currently reports1.3.14 and has changed bytes since the preceding
observation; exact source copies/hashes are retained privately. This observation
does not select a target Bun version or bless mutable installed state. OPS is
still the previously observed modified legacy binary, not the trusted CLI target.
No Go executable was found on PATH, so a native source build must not silently
download a toolchain or dependencies.

The installed unprivileged bubblewrap preflight with /bin/true failed at
loopback setup with EPERM. No OPS or candidate native binary was run by that
probe. Native test execution remains blocked rather than falling back to the
real host home/network. No services, namespace configuration or host policies
were changed to satisfy the test.

Metadata/source discovery is distinct from permission to fetch image layers,
executable archives, build toolchains or package dependencies. Inspect the
reviewable source/build contracts before preparing any such subsequent batch.

### Plan resumed on 2026-11-19

The local suite passed 171 distinct migration and provenance tests in standard
and optimized Python. The same cases run in each mode. The test suite includes
a mocked registry 403 response. The existing native provenance source remains
at its local checkpoint and still needs independent review. The verified
metadata receipt is b6bb4eb48023d004239e56e2b146144ed87dda0627c002ee3d09787090fc9025.
The Control Plane change feed contained zero updates.

Split the next acquisition into a small metadata step and a separate
artifact step. Verify OCI manifest and config identity for the exact base
candidates before fetching layers. Freeze the platform, manifest, config and
layer digests in the artifact request. Keep the original 49-role catalog
unchanged through qualification. The existing draft with an 8 GiB ceiling is
a planning input. Its artifact downloads remain pending separate authorization.

1. Qualify the custom operator, OPS 0.9.0 and Bun as one dispatch path.
   Bind the exact operator source, its Python/Poetry recipe and native
   embedded tools. Verify the CLI and Bun with the target task checkout in
   an isolated ARM64 environment. Record dispatch, task help and dry-run
   results against the same source and executable identities. The installed
   host CLI and Bun observations remain available for comparison.
2. Treat .NET 2.2 as the critical compatibility decision. The pinned
   candidate recipe uses `sdk:2.2-alpine` and `runtime:2.2-alpine`.
   Qualify their ARM64 manifest and ABI first. The draft also lists
   non-Alpine candidates. Those require explicit equivalence evidence before
   selection. Ruby 2.5 requires exact gem/platform proof and Rust 1.34
   requires the pinned Go proxy source/build plus the native Rust binary.
   If a role cannot be preserved, present the exact compatibility decision
   before changing or removing it.
3. Qualify the same-host sequence with synthetic data in an isolated rehearsal.
   Inventory every Kind workload, volume, image, tenant and access grant.
   Verify encrypted backup recovery and independent access to restore material.
   Keep source and target writers, triggers and sends fenced through data
   verification. The restore schedule-resume step requires a separate
   activation decision. Check Ollama model bytes and GPU access after the core
   restore. Test private reachability and DNS/port conflicts for retained Docker
   services before restoring their application endpoints.

Maintenance, source stop, K3s installation and restore remain phase 2 onward.

### Operator decision on unused catalog runtimes

The operator approves omitting unused optional runtimes. The narrow first scope
is the three legacy bundles named in the release. Every saved action in every
archived OpenWhisk namespace contributes to the decision. Resolve aliases and
protect blackbox images, system and prewarm entries, source defaults that
remaining entries still use, and platform roles. Verify the bound result before
source stop and again against the unpacked archive before importing images.
An omitted runtime can be registered with compatible image bytes when it is
needed.

This makes the three legacy images conditional on real dependencies. The custom
operator, target OPS/Bun, ARM64 compatibility and complete native rehearsal
remain qualification gates. The branch changes only the migrator and the
destination catalog selection. Operational phases remain unstarted.

The candidate passed 259 migration and restore tests in normal and optimized
Python. These are the same cases in each mode. The separate adapter-scope suite
reported three existing isolation-fixture failures. The same three case IDs
failed against the preceding driver source. Independent source review is pending.
