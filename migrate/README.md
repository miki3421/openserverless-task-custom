# Migration candidate

## Select target version and source installation

```sh
ops migrate --to:0.9.0 --from:k3s --check
ops migrate --to:0.9.0 --from:k3s
ops migrate status --to:0.9.0 --from:k3s
```

The equivalent standard spelling is `--to=0.9.0 --from=k3s`. Here `to` selects
the target **OpenServerless version** and `from` selects the source **installation
type**. The source 0.1.0 layout is independently inspected; a CLI assertion does
not override the observed host, cluster, namespace, workload or image identities.
Both spellings are exercised through a real OPS binary with a stub executor.

The K3s route reuses the accepted `ops upgrade` engine and all its phase gates.
It automatically discovers the local source and builds its private migration
profile and checksum-pinned software capsule. No manually authored upgrade
JSON, tenant list, application `.env`, Codex directory or per-application deploy
is required. Its profile is separate from the existing `OPS_HOME/upgrade.json`:
`OPS_HOME/migrate/k3s-010-to-090.json`. Existing profiles and failed-run evidence
are never silently replaced or advanced to a new code revision.

`--check` and `status` do not download inputs, pull images, stop services or
change Kubernetes. If no prepared capsule exists, `--check` inspects the source
but returns `preparation_required` with exit2 and `migrationReady:false`;
unavailable asset verification is not reported as PASS. The normal migration
command stages inputs first, then the existing engine verifies them before
maintenance. A valid retained profile allows `--check` to run the full existing
engine preflight. `status` can read the retained engine journal after cutover
without requiring the original source to remain online.

Read-only discovery also reports missing original source-image content as
`sourceImageCachePreparationRequired:true`. It does not fetch that content or
claim export completeness. The normal command recovers a missing root only from
an original public registry identity at the exact observed digest, after the
same acquisition-capacity and filesystem/reserve checks used for target staging.
It uses content-only fetch, never unpack/tag substitution, and rechecks every
source reference plus the unchanged host/cluster binding afterward. An absent
public identity requires independently verified original local input; unavailable
bytes, corrupt metadata and unqualified platforms remain errors. No image is
omitted. Repeated incomplete roots or more than64 recovered roots stop before
maintenance. The existing upgrade preflight/export gates stay strict.

The preparation worker returns exit2 for `preparation_required`; this CLI can
wrap that task exit as process exit1. Inspect the structured state: it is not a
complete preflight PASS. The normal migration command performs preparation
automatically before its existing full preflight and maintenance phases.

Normal K3s preparation reuses manifest bytes from its protected bounded metadata
cache, then from existing source containerd content, and finally from the original
registry when the exact digest is absent locally. Every origin is checked against
the pinned hash and manifest schema. Cache corruption and a failed local read
remain errors; neither causes digest substitution. Metadata reads are bounded in
size/time and do not pull, retag or mutate source content. Availability checks and
the complete acquisition graph share the same verified cache. This reduces repeat
registry requests without assuming layer/cache reuse in capacity calculations.
After the acquisition bound passes, verified original manifest bytes are seeded
into the owned temporary namespace with their exact sizes and hashes. This
avoids fetching the same manifests again during content acquisition. Seeding
never creates snapshots, reconstructs a manifest/index or changes the source
namespace. Root protection keeps these bounded objects available until normal
owned-namespace cleanup; failed staging retains its receipt and diagnostics.
HTTP429 retries are limited and honor `Retry-After`; an excessive cooldown stops
preparation. No alternate identity, registry or image is selected to bypass a limit.
These caches and network retries are not used by read-only `--check`/`status`.

During normal preparation the pinned target image content is fetched without
unpacking into a dedicated, uniquely owned containerd namespace and exported for
offline recovery. It never retags the running source's `k8s.io` namespace. A
shared mutable tag may therefore retain the original source root while the target
uses its separately pinned root. Acquired target workload images use immutable
references in the migration profile; both tag and immutable aliases are exported,
so later source-cache import cannot silently select the old root for a target
workload. The separately verified operator candidate retains its repository/tag
contract. Unselected entries of the full configuration catalog remain unchanged;
no image is excluded from the required acquisition set.

The temporary namespace is released only after complete archive and expansion
verification, with ownership and alias checks. A failure retains its private
namespace receipt and diagnostics. Capacity/reserve checks still precede every
fetch and export. These operations are explicitly outside read-only check mode.
The target K3s **binary is downloaded and verified** into
the capsule; the running source K3s binary is not substituted for it. Source
identity, workload readiness and exportable cache are checked again after
staging and by the engine before freezing applications. The migration lock is
held across preparation and engine execution. Original K3s files/data and the
fresh encrypted backup remain retained under the established rollback contract.

This adapter keeps the qualified native collection/encrypted archive path of
`ops upgrade`. It does not silently replace it with the separate Kind
Velero/Versity host-store implementation currently under independent PA review.
It uses the target catalog already pinned in this task: one personal operator
artifact, with official Controller/Admin API/Streamer references. That catalog
combination and the new automatic K3s wrapper require their own live rehearsal;
the earlier accepted K3s run is evidence for the reused engine, not a new run.

The initial source remains the qualified single-node Linux AMD64 legacy0.1.0
layout on `v1.27.7-rc1+k3s2`, standard K3s paths, ten PVCs, all required native
backends and TLS disabled. This is a fresh-control-plane migration to pinned
K3s `v1.36.4+k3s1`, not an in-place Kubernetes datastore version jump. Other
K3s versions, distributions, external datastores, TLS resources and layouts
remain rejected. Run from the non-root administrator's default OPS home with
the qualified installed OPS/Bun, Python3.12 and administrator sudo access.
Application-specific acceptance remains separate from generic completion.

The old `ops upgrade` interface remains available, including its explicitly
reviewed resume contract. The new migration wrapper does not automatically
replay a failed data restore or bypass the existing checkpoint review.

## Existing Kind-to-K3s route

`ops migrate --to=k3s` orchestrates the opt-in host-store rehearsal from a
completed `ops backup` generation: verify the exact selection, hydrate its
encrypted native set, stage pinned inputs, stop the selected Kind container,
install fresh native K3s/cert-manager, prepare target CRDs/RBAC and run the
existing restore checks and restore. Docker remains running. No Docker service,
socket, restart policy, source data or installation is disabled or removed.

For a fresh run, Docker must be reachable through its protected local Unix
socket, with the exact source daemon, default context, container ID and Kind
label. A remote context is rejected. By default another running container blocks
migration. To include external services in the maintenance stop, provide the
private mode0600 file `OPS_HOME/migrate/host-services.json` before the approved
run. Its closed structure is:

```json
{
  "schemaVersion": 1,
  "containers": [
    {
      "id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "disposition": "retain-docker"
    },
    {
      "id": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "disposition": "move-to-k3s"
    }
  ]
}
```

The IDs above are synthetic. Supply actual full IDs through the private file;
never put operational values in source control. Entries define external stop
order, e.g. application/bridge before its database. The selected Kind container
is always last and cannot be listed as an external service. `keep-stopped` is
allowed only for an already stopped container. Additional unselected stopped
containers remain stopped and are inventoried; unselected running containers or
another Kind cluster fail closed. No implicit wildcard selection is accepted.

Before effects, the private runtime record freezes the complete container set,
image identities, original running flags, restart policies and dispositions.
Every stop rechecks the exact inventory. Partial failure stops the procedure;
it never restarts or retries a container. `restart-proposal.private.json` lists
only originally active `retain-docker` containers; it is evidence for a later
reviewed step, not an automatic restart command. Kind, originally stopped and
`move-to-k3s` containers remain stopped. Disposition does not back up or migrate
external-service data or move Ollama by itself.

The root installer independently rechecks this evidence against the local socket
and daemon before effects. A version2 root target marker binds it to the selected
archive/source and rechecks all containers stopped at restore preflight and each
restore phase. Missing/malformed/version-drift proof fails closed. Existing
version1 prepared targets and the isolated restore route retain their original
Docker-stopped-and-disabled checks; no automatic marker or checkpoint upgrade.

`--check` observes current identities but never stops a container, installs K3s,
downloads software or changes runtime configuration. New runs do not start an
unavailable Docker daemon. The legacy stopped-daemon preparation remains only
under the unchanged explicit legacy proof. An existing unrelated K3s target or
application restore checkpoint requires separate review.

This route's software catalog remains a Linux AMD64, single-host candidate.
The new Docker-preservation contract is locally qualified only; native ARM64
catalogs, whole-host networking/GPU setup and actual restore acceptance remain
open. The protected host-store generation and all existing archive, source,
capacity, physical-host and empty-target gates remain required.

An already prepared empty target can resume only with the same host, cluster
UID, backup snapshot and verified capsule. Version2 requires the same live
Docker daemon and exact stopped inventory; version1 requires daemon shutdown.
Only descendant wrapper-only changes may refresh an old code pin; restore worker
changes still require explicit checkpoint review. Once application restore has
started, automatic replay remains refused.

See [the whole-host sequence](host-migration-plan.md) for the separate Ollama,
retained-service reconnection, acceptance and deliberate activation phases.

Kubernetes prepare and restore explicitly use the prepared K3s client rather
than an inherited kind context. Prepare failures propagate to the caller. At
successful completion, the selected profile's client cache is switched to K3s
and its original kind client is retained privately for rollback.

`ops migrate prepare --to=k3s` is the preparatory step for the qualified
same-host kind0.1.0 to K3s0.9.0 rehearsal. It runs after installing the target
K3s with `ops cloud k3s`, before `ops setup kubernetes prepare` and
`ops restore`. It also remains available as the explicit preparation interface
used internally by the wrapper.

The operator needs no per-application names, `.env` files, manually edited
restore JSON, root target marker or Codex helper directory. Application
configuration, credentials and definitions already deployed to OpenServerless
come from the encrypted backup. Files and secrets that existed only on a
developer workstation remain outside that claim. External services are not
included automatically.

## Usage and effects

```sh
ops migrate prepare --to=k3s --check
ops migrate prepare --to=k3s
ops setup kubernetes prepare
ops restore --check
ops restore
```

The first command validates prerequisites and reads encrypted metadata. The
second downloads software, populates the target containerd image cache and
writes private restore settings. Neither deploys applications, imports source
Kubernetes metadata or restores backend data. The selected Kind source stays
stopped under its original versioned runtime proof.
The recovery repository and independent password file remain unchanged.

By default, preparation finds the exact completed, encrypted-file-verified
`ops backup` run from the source or selected OPS profile. If this metadata is
not available, supply the local repository and independent key explicitly:

```sh
ops migrate prepare --to=k3s --from=/backups/repository --key-file=/recovery/password
```

An explicitly supplied repository with multiple snapshots also requires the
exact `--snapshot=<id>`. Preparation reads the source identity using Restic
`dump`; it does not depend on retained plaintext capture directories. This
initial route still requires the source hostname and the local target hostname
to match. Legacy archives do not attest the source physical-host UUID.

Private evidence is retained under `OPS_HOME/migrate/prepare-<id>`. Successful
preparation creates `OPS_HOME/migrate/prepared.json`, which selects a protected
target profile under the user's `.ops/profiles` directory. Kubernetes prepare
and restore resolve that context automatically. The stopped source kind cache
is retained. Repeating preparation verifies the existing exact selection;
different archives or targets require explicit review.

The root target binding pins the cluster UID, standard bootstrap controllers,
system service files and network. If the namespace does not exist yet, the
binding records that state. Restore automatically binds its UID after Kubernetes
prepare, allowing that single transition. A changed bound UID, foreign workload,
existing PV/PVC, application definitions or populated application configuration
is rejected. The ordinary isolated restore route keeps its stricter checks.

## Minimum image candidate

Custom images are not an intrinsic requirement of backup or migration. This
candidate retains **one** personal operator image, with the restore changes
already exercised by the previous rehearsal. Controller, Admin API and Streamer
now use the official Apache0.9.0 references from the upstream task catalog.
Their immutable roots were resolved anonymously and pinned before testing;
tags are never resolved dynamically by the user command.

The operator changes handle restored Milvus paths, existing CouchDB state,
SeaweedFS IAM/storage settings, Redis ACL persistence and controlled platform
image selection. See [required operator changes](required-operator-changes.md).
The artifact retains the previously tested operator source; it is not a new
claim that every individual hunk is mathematically minimal. No new operator
build is required for this candidate.

`releases/k3s-0.9.0.json` pins tools, target task source and image roots. Downloads
use HTTPS and verified hashes. Image acquisition uses K3s containerd; the
preparation does not start or stop Docker. A reusable software capsule is assembled locally for the restore
workers. Operators do not need a separately supplied offline kit.

## Acquisition capacity gates

Before target-image acquisition, a metadata-only walk of every pinned root bounds
the compressed content, fetch scratch, two retained exports and software staging.
Required references come from the pinned release and the selected-backup
runtime decision below. Shared content still retains every required alias and
does not justify assuming cache reuse. The bound includes manifest/configuration
metadata for unselected platforms, but selects Linux AMD64 layer content only.
Unsupported descriptors and compression stop preparation.

The bare Kind wrapper performs this check before stopping source containers; preparation
repeats it against the actual K3s target and its kubelet eviction/image-GC policy.
Every fetch and export revalidates the same selected filesystem and its remaining
work plus reserve. Only completed bounded stages reduce remaining work; unrelated
source growth does not count as progress. Separate software/image/data filesystems
are rejected until qualified.

The acquisition command is `ctr content fetch --all-metadata --platform linux/amd64`,
whose client fetch path does not unpack layers. After export, the canonical OCI
validator checks the original archive bytes and expanded snapshot bound before
the first image import. Restore retains its additional combined check for source
images, target images and native recovery. Initial acquisition capacity does not
certify that this later, more detailed expansion check will pass.

The host-store physical allocation contract is separate. The new local backing
adapter requires fully allocated local ext4 storage and a qualified physical block
path on a non-virtualized host. A guest cannot attest free capacity in its host's
sparse QCOW2 or thin pool. New or previously sparse VM destinations are blocked
pending separate external reservation qualification; no flag bypasses that gate.
The earlier successful AMD64 VM rehearsal predates this correction and does not
qualify this new contract. No new live operation is implied by synthetic tests.

The single required operator artifact is distributed through personal GHCR.
The maintainer-only publication workflow verifies the exact OCI archive and
copies it with digest preservation, using an ephemeral GitHub Actions token.
It cannot publish the other components or write to Apache. Registry visibility
and anonymous pull access are independently checked before preparation passes.

The reduced combination completed a separate isolated Linux AMD64 rehearsal
with a fresh target: the bare migration command completed, final IAM and the
selected user kubeconfig were verified, and Alpha/Beta retained their original
credentials, frontends, Python/Node.js behavior and synthetic data across all
five backends. Reciprocal private action requests returned403. The same exact
encrypted backup generation had also passed an independent Docker recovery
after a post-backup fixture change. These are local application results for the
pinned catalog and fixture, not certification of production cutover, other
architectures, remote filesystems or the earlier complete security baseline.

The software catalog currently qualifies Linux AMD64, Python3.12,
K3s1.36.4+k3s1 and the exact OPS/Bun binaries used by the rehearsal. Standard
K3s addons and cert-manager must be ready. The restore subsequently verifies
source-image closure and restored data. Application compatibility and existing
security gaps in official images remain separate acceptance considerations.

## Validation

```sh
python3 -B -m unittest discover -s migrate -p 'test_*.py'
python3 -O -B -m unittest discover -s migrate -p 'test_*.py'
bun test --no-install migrate/main.test.ts migrate/cli.test.ts migrate/k3s.test.ts
```

Set `OPS_TEST_BINARY` to the real OPS executable for the command-dispatch test;
the fixture replaces the migration executor and never accesses a cluster.

The maintainer-only `release_images.py` exports only the explicit
`customImageSlots` from an existing OCI archive, verifying the dependency closure
and preserving manifest/config/layer bytes. It never publishes images or runs
Docker. `publish_images.py --check` verifies the reviewed operator artifact
without registry writes. Publication is restricted to the personal fork's CI.

### Feedback during long operations

Human output distinguishes image export, archive/expanded-space verification,
input SHA-256 calculation and the final source recheck. Preparation and engine
phases emit a waiting update every20 seconds during long operations, with elapsed
waiting time. This reports waiting rather than a percentage or estimated completion.
Private command output remains in the protected diagnostics. The JSON option does
not add these periodic human messages. Known failed backup components are named using a fixed message; raw errors and
command arguments are not forwarded. Feedback does not retry or replay phases.

### ARM64 qualification preparation

The offline `python3 -B migrate/qualify_arm64.py` auditor reads explicitly supplied
local catalog/installer/tool/OCI/wheel identities. It never downloads, executes
native tools or changes migration guards. Exit2 reports missing or incompatible
inputs; even identity-pass is not native runtime or migration readiness.
See [ARM64 and full-path checks](arm64-full-path-checks.md) for current blockers,
evidence levels and unexecuted native/complete-rehearsal gates. Do not repin the
AMD64 catalog to local binary hashes or enable ARM64 by removing its guards.

### ARM64 native staging and restore-path preparation

The five previously pinned upstream native inputs have been acquired and
verified offline; see [native byte findings](arm64-native-findings.json) and the
[current complete-path matrix](arm64-full-path-checks.md). They are not installed
or executed. Explicit platform propagation now covers acquisition/expansion,
source-cache fetch, image imports/proofs and worker CLI/ELF paths. Existing
profiles and operational host/catalog guards remain AMD64: four image roots and
target OPS/Bun still block a complete native catalog. No ARM64 operational route
or migration is enabled by this preparation.

### Optional legacy runtimes for fresh same-host migration

The release lists the exact .NET 2.2, Ruby 2.5 and Rust 1.34 image references
eligible for omission. Before image preflight, `ops migrate --to=k3s` and its
check read the exact selected encrypted archive. The logical export binds
every namespace entity to its document ID, revision, type and runtime.
Saved kind aliases resolve against the source catalog. Saved actions, their
runtime families, saved and configured blackboxes, system kinds, prewarm entries,
and nonoptional platform images remain protected.

The permitted omissions narrow target acquisition and the installed runtime
catalog. The archive and source image cache retain their original contents.
Prepared assets bind the selection to the snapshot and to the catalog digest.
Restore recomputes it before image import. An existing prepared profile without
that proof keeps its full catalog. Future use of an omitted runtime requires
registering it with compatible image bytes. AMD64 operational gates and
separate native ARM64 qualification continue to apply.
