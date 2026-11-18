# ARM64 qualification and complete-path verification

Date2026-11-18. Status: **blocked for native migration — offline audit reviewed; upstream
metadata completed, four selected image configurations are AMD64**.
Scope: the existing Kind0.1.0 to native K3s/OPS0.9.0 migrator. Application source,
configuration, permissions, running workloads, Docker, Kind and models remain
unchanged. No operational migration, service stop, restore, image import, VM,
GPU workload, installation, download or new environment variable is performed by
this document or the offline audit. Separate maintenance approval remains required.

## Evidence levels

1. **Detected:** a local binary is ELF64 ARM64. This is not a trusted target pin,
   target version, ABI check or execution result.
2. **Identity verified:** complete selected local metadata and bytes match an
   explicitly reviewed ARM64 catalog and native platform. Layer metadata is not
   layer-content validation; wheel tags are not native import qualification.
3. **Native/runtime qualified:** exact tools, clients and images pass the intended
   isolated ARM64 runtime/CLI/ABI checks. No privileged production profile is used.
4. **Complete rehearsal:** a separately authorized isolated ARM64 source/target
   migration preserves state, isolation and recovery under the intended versions.
5. **Production accepted:** approved maintenance plus operator application checks.
   Neither a rehearsal nor healthy infrastructure proves operator acceptance.

The offline tool always returns migrationReady=false and
nativeRuntimeQualified=false. Missing metadata is BLOCKED, not an exclusion or
permission to resolve another image. The existing AMD64 catalog, original image
roots, target hashes, generated engine and predecessor restore guards stay exact.
A new ARM64 catalog and source contract need positive evidence and review before
any operational route is enabled.

## Offline audit — implemented, local qualification in progress

```sh
python3 -B migrate/qualify_arm64.py --help
python3 -B -m unittest discover -s migrate -p test_qualify_arm64.py
```

The audit accepts an explicit candidate catalog/installer and optional absolute
`--tool ROLE=PATH` inputs for ops,bun,k3s,restic,milvus-backup. It never executes
them or searches PATH. Optional `--metadata-dir` stores original OCI JSON bytes
as blobs/sha256/DIGEST_HEX. Optional `--wheel-dir` stores the exact wheel basename
from each pinned URL. There is no registry/provider/cache fallback or input copy.
Files, parent paths and digests/sizes are checked before use. Exit2 means blocked;
exit0 means identity checks passed only, never operational qualification.

For an indexed image require one unambiguous Linux ARM64/v8 child, exact original
root/child/config bytes, descriptor sizes and an ARM64 configuration. A label
without a matching config is insufficient. Unindexed manifests also require
configuration proof. No layer is downloaded or claimed verified. Bound graph
work and reject duplicate keys, missing/corrupt/linked objects, bad variants,
foreign OS/configs, cycles/depth overflow and duplicate image roles.

For binaries require BOTH the reviewed full-file hash and native ELF identity.
For CP312 native wheels verify reviewed wheel hash/size, filename, bounded safe
ZIP members and every native ELF member; imports remain NOT_RUN. Platform-neutral
wheels still need their exact pinned bytes. Report remaining AMD64 source paths
and default architecture propagation, without editing those operational guards.
The static scan is a blocker inventory, not proof that a refactored source works.

### Initial actual-host findings (no tool execution)

- Native OPS/Bun/kubectl/Helm executables are ELF ARM64. Installed OPS build
  metadata reports0.1.0-2409121919.dev, Go1.22.7 and modified source. It is not the
  target CLI attested by the migration catalog; no binary is replaced or repinned.
- Existing target catalog and installer are AMD64. Existing native OPS/Bun
  hashes do not match their AMD64 catalog pins. K3s, Restic and Milvus are absent
  from the explicitly inspected qualification paths; do not claim absent from
  every possible host directory or search private service configuration for them.
- All49pinned image roles lack complete local root/ARM-child/config evidence in
  the selected qualification store. This is not a registry availability result.
- PyMongo's selected CP312 wheel is x86_64; platform-neutral dnspython still lacks
  local verified wheel bytes. Source paths and imports also bind AMD64.
- Shared canonical OCI helpers already accept explicit architecture parameters;
  migrate/acquisition currently omits them and falls back to AMD64 defaults.
  Do not edit a generated engine copy to hide that wrapper propagation gap.

## Verification matrix — prepared, operational cases NOT_RUN

| ID / level | Check and minimum oracle | Current state / execution owner |
| --- | --- | --- |
| A01 identity | Exact CLI/tasks/engine revisions; ARM64 OPS/Bun/K3s/Restic/Milvus and client hashes/ELF/ABI. Preserve current global OPS | blocked missing target inputs; local artifact audit only |
| A02 identity | All49target catalog roles have exact native root/child/config and full layer closure; source runtime images and extra workload closure separately verified | local metadata audit prepared; layers NOT_RUN |
| A03 native | CP312 ARM64 PyMongo/dnspython imports, etcd restore ELF, native tools/version/CLI parsing with original-source dispatch and no self-update/download | NOT_RUN; isolated qualification after approved staging |
| A04 source | Explicit ARM architecture propagated through acquisition, export/import, source cache, restore peak storage, worker paths and expected-image proofs | blocked current AMD64 source contract; no guard weakening |
| B01 inventory | Every Kind namespace/controller/PVC/claim/data location and image assigned migrate/reconstruct/retain-inactive; no unaccounted extras or automatic old-agent activation | prepared; fresh sanitized inventory before maintenance |
| B02 backup | Exact complete installation generation, independent key/off-host access, checksums/native restore methods, source/host/physical capacity and immutable original images | prepared; no backup performed; data-only backup is not this gate |
| C01 boundary | --check performs no stop/install/download; unexpected daemon/context/image/plan/inventory drift rejects before effects | prior local wrapper tests PASS; native CLI dispatch qualification pending |
| C02 recovery | Durable original state before effects; ordered selected stops and Kind last, Docker preserved. Sync/stop/timeouts halt; no blind rerun/restart/rollback | prior21frozen + author evidence PASS; actual stop NOT_RUN |
| D01 bootstrap | Exact ARM K3s/checksums, ports/CIDRs/host listener ownership, fresh empty target, standard addons; no external application preload before core restore | NOT_RUN; isolated ARM64 qualification first |
| E01 data | Native backend restore plus tenant credentials/Redis ACLs, Journal/session/queue/outbox identities, TTL/checkpoints, provider references and actual PVC allocations preserved | NOT_RUN; synthetic source on isolated target, then operator-approved source |
| E02 isolation | Original credentials valid; peer/anonymous access denied where required; final IAM checked after last restore. No broad permissions or public backend exposure | NOT_RUN; controlled isolated requests, no real user payloads |
| E03 execution fence | Persistently suspend ingress/domain writers/triggers/schedules/sends before final capture and through validation. Prove no domain writes even without human access | NOT_RUN and required before migration; existing resume-schedules phase needs explicit cutover review |
| F01 Ollama | Same selected model bytes/profile and GPU access; old instance stopped, new one owned; qualified shared GPU scheduling with speech; no model download | NOT_RUN; separate approved move after core restore |
| F02 Docker | Retained services originally active restart in reviewed order; originally stopped/Kind/moved Ollama remain stopped. Stable private endpoints both directions, authentication and no duplicate readers/bridges/writers | NOT_RUN; no private configuration copy |
| G01 acceptance | Web/User/admin permissions, PA private/group flow, native contacts, image/voice, Calendar/activities/Journal, reminders/alerts/report schedules. Exact receipts, no duplicate effects or data loss | NOT_RUN; production business checks by operator only |
| G02 lifecycle | Reboot persistence, encrypted autonomous scheduled backup, future immutable build/registry/deploy workflow and source-retirement decision | NOT_RUN; separate approved operational checks |
| G03 recovery | Failures before/after restore, uncertain sends, target reboot and rollback before/after new writes; preserve exact original proofs and reconcile new writes | simulated boundary subset PASS; full isolated recovery NOT_RUN |

## Next bounded input step

Prepare a closed metadata-only request: exact current49image roots and uniquely
selected ARM child/config descriptors; primary checksum/release/distribution
metadata for the existing K3s,Restic,Milvus,PyMongo,dnspython versions. No image
layers,binaries,models or installations. Verify the request SHA before execution;
operator approval is required by the published company download rule. Cache
original bytes privately with their hashes; never publish authentication tokens,
headers, signed URLs, private endpoints or configuration contents. Preserve
missing/foreign/unauthorized artifacts as explicit failures, without substitution.

After metadata resolution, prepare exact required ARM64 binary/wheel/operator
artifact inputs and obtain the applicable download/build approval. Only then
freeze a reviewed ARM catalog and qualify the source port and native harness.
Any local isolated guest or hosted rehearsal is separately specified/authorized;
this plan does not create it. No migration start or service-stop command is
included in the current qualification batch.

## Author checkpoint

Offline author qualification:15new synthetic audit cases PASS; complete affected
migration suite138 and restore suite84 PASS, repeated separately under optimized
Python (222distinct cases, not444). Independent18audit cases were frozen before
implementation, manifest digest
440f340d945e4564b502ad0f94df6543d0afba5108c57ce55628856b5ea2bacb.
Final independent audit review is pending. Current source/catalog hashes and
original predecessor/durability evidence are retained separately; no native
ARM64 migration acceptance is inferred. At the initial checkpoint the metadata-only request was pending approval;
no network artifact input had been acquired.

### Independent wheel-content correction

Candidate39252265 has an independent HOLD:16frozen cases PASS;2FAIL showed a
pure-any wheel containing an extensionless ELF and an ARM64 .so alongside an
AMD64 .so.1 incorrectly accepted by extension-only scanning. Original fixtures,
result and HOLD receipt remain retained (digest
9c8bc7d57d1e44cb2267f87f69d0cfed8ed0265a13ee6126b942177ea089c089).
The correction reads a bounded prefix of every non-directory ZIP member,
rejects any ELF in pure-any wheels and verifies every ELF as ARM64 regardless
filename. Existing .so missing-ELF rejection and size/hash/ZIP guards remain.
Explicit absolute tool paths are enforced in the API as well as CLI. No native
code is executed and no operational capability or platform catalog is changed.
New independent immutable rerun is pending on the corrected candidate.
Author141migration +84restore cases now PASS in normal and optimized modes
(225distinct);18new audit cases include both wheel-content regressions.

### Completed authorized metadata acquisition

Operator explicitly approves the closed metadata-only batch, request digest
24800d7817db086227c0ca235bb3597c2a4446c4e5c667b8ca9c4493dd9a876b.
State:completed. Read only the49original image roots, unique ARM children and
configuration blobs plus5named primary checksum/release/distribution documents;
128MiB/512request ceilings. No mutable-tag resolution, image layers, executables,
models, installation or service changes. Original content-addressed bytes and a
closed receipt remain private. This does not authorize the next binary/build or
operational batch. Metadata failures stay explicit; no version/digest substitution.

## Current result — qualification BLOCKED

Exact audit source39709c5f52f5a03616ece59d438cf8c1ef4de81c has independent GO,
receipt digestec43bb39039e8292440df40294377cea4a54fc17b8ba024f8d120dc04072fdd3.
All18frozen independent controls PASS in normal/optimized modes; author141migration
and84restore cases PASS in both modes (225distinct). Prior392HOLD remains retained.
This GO qualifies the audit, not the artifacts or migration.

The approved batch completed49/49image roles and5/5primary tool metadata inputs:
750728bytes in275HTTP requests; no layers/executables/models/installations or
service changes. Source catalog digest93c601a0 is unchanged. The exact existing
root/ARM-child/config proof verifies45ARM64 configurations; the following FOUR
selected digests resolve to AMD64 configurations:

| Existing catalog role | Blocker | Required disposition before ARM64 qualification |
| --- | --- | --- |
| Custom migration operator at source4a325f729690 | Selected immutable operator artifact is AMD64 | Qualify an ARM64 artifact preserving the exact required restore behavior/source |
| OpenWhisk action-dotnet-v2.2:nightly | Selected immutable runtime artifact is AMD64 | Resolve an approved native-compatible artifact or explicitly reviewed catalog decision; never omit silently |
| OpenWhisk action-ruby-v2.5:nightly | Selected immutable runtime artifact is AMD64 | Same closed artifact/catalog decision |
| OpenWhisk action-rust-v1.34:nightly | Selected immutable runtime artifact is AMD64 | Same closed artifact/catalog decision |

This finding concerns the FIXED digests, not a claim about every tag/platform
published under those repository names. No mutable tag was resolved and no
reference/version/digest was substituted. Layer closure, native startup and
security/application compatibility remain untested even for the45positive roles.

The [public metadata findings](arm64-metadata-findings.json) retain original
root/selected-manifest/config identities and upstream-only native input proposals.
Official metadata establishes an ARM64 K3s checksum, Restic archive checksum,
Milvus ARM64 archive identity and CP312 ARM64 PyMongo/platform-neutral dnspython
wheel identities. At that metadata checkpoint their bytes were not downloaded or ELF/import-qualified.
The subsequent explicitly authorized byte-staging iteration is recorded below.
These proposals do not rewrite the installedTools pins or authorize downloads.
The native target CLI/Bun/tool provenance and12wrapper/worker architecture
contracts still need qualification; current local OPS0.1.0 is preserved.

The complete-path verification matrix is prepared, with operational rows NOT_RUN.
Next work is resolving the four fixed-digest blockers and trusted native target
inputs, then a reviewed architecture port and isolated full rehearsal. No guards
are disabled, catalog roles dropped, architecture emulation introduced, or main
branch merged by this audit. No maintenance/start/stop instruction is executed.

### Independent metadata closeout

Exact5ab691d348e06c3fddc41455e3a38febfc90eda9 metadata/docs independently reviewed
GO, receipt digest154c2cd8cdbf8f968c5f575d3967a448664bc4c6152e08a5b75f9acf92e00679.
All49ref/root identities match the unchanged catalog;143original root/child/config
JSON observations and descriptor sizes independently reproduce45ARM64/4AMD64.
All5native URL/hash/size proposals match the approved primary metadata. Actual
binary/layer/ABI/runtime and complete migration gates remain BLOCKED/NOT_RUN.
The final follow-up records this receipt only and does not alter audited code,
operational catalogs, source guards or application. Publish the separate branch;
no main merge or additional download/operation is implied.

## Native byte staging and explicit restore paths — 2026-11-18

State: **bounded preparation completed and independently reviewed; operational ARM64 blocked**.
The operator explicitly authorized acquiring the missing native inputs. The
closed five-input manifest is `releases/arm64-native-inputs.json`, not a target
release catalog. `stage_native_artifacts.py` is offline-only: no network, tool
execution, package import, installation, registry operation or service access.
Original SHA/size checks precede staging; safe bounded archive handling and
ELF64 little-endian AArch64 identity guard binaries. Both complete original
wheels retain their SHA/size and native-member checks. See the public, path-free
`arm64-native-findings.json` for exact proofs and pending gates. Computed inner
binary hashes are observations anchored by the upstream archive, not an
independent target CLI/tool attestation or ABI qualification.

All five inputs now have byte identity proofs: K3s v1.36.4+k3s1,
Restic0.19.1, Milvus Backup0.6.1, PyMongo4.18.2 CP312 ARM64, dnspython2.9.0.
They are retained privately for the next native qualification; global binaries,
installed OPS, target catalog and installer pins remain untouched.

`restore/platform_contract.py` defines closed platform, CLI directory and native
ELF primitives. Acquisition records its selected platform and propagates it to
canonical OCI expansion checks, fetch and export. Source-cache recovery takes
the explicitly proven source platform; it never infers it from a target. Restore
imports/storage and worker image proofs, etcd identity and CLI paths now consume
selected constants. Native client directory discovery supports ARM64 without
changing the persisted target platform.

This is preparatory source plumbing, not an enabled ARM64 restore route. Existing
restore profile1 remains exactly AMD64; new schema/platform fields are rejected.
Root installer and target guards still reject unqualified ARM64. Existing marker2
continues to mean sourceRuntime proof only. New persisted ARM64 profile/marker/
archive contracts must bind all native catalog/tool/source proofs before enablement.
The old upgrade path does not load a new restore-only module; worker defaults
retain its previous AMD64 behavior. Frozen checkpoint/code mismatch still stops
resume rather than silently refreshing workers. The canonical backup engine is
unchanged.

Still blocked: the four selected AMD64 image roots, target OPS/Bun provenance,
full image layer closure, source architecture proof, native ABI/imports and
isolated complete rehearsal. No role is removed, no emulation/version change or
mutable-tag replacement is introduced. Operational phases2..8 remain NOT_STARTED.

Independent preparation GO on immutable source9bfbbd843ce3e6f12c16d2289b37e2f1a5a3d94c:
receipt e1616885157ff2534cad7b838950a9661c68cad760b12df029405655302f69e6.
Twenty-four independent preparation controls PASS normal/-O,19focused replays
PASS and all5original inputs/extractions independently crosschecked. This does
not satisfy deferred positive ARM profile/marker/native/ABI/full-rehearsal
aspects; see the current host plan for exact retained limitations.
