<!---
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements.  See the NOTICE file
distributed with this work for additional information
regarding copyright ownership.  The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License.  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied.  See the License for the
specific language governing permissions and limitations
under the License.
-->
# Read-only update planning

## Migration inventory and portable export contract

```sh
ops update inventory --namespace=nuvolaris --json
ops update inventory --namespace=openserverless --context=source --json
```

This is the first executable migration phase. It supports arbitrary numbers of
tenants and stored OpenWhisk resources, without application-specific names,
source repositories or health endpoints. Applications are not a reliable OPS
inventory unit: a namespace can contain several packages and applications.
The unit of coverage is every namespace, identity and stored action, package,
trigger and rule, including empty tenants and resources inside packages.

Discovery uses the served Whisk API group (`nuvolaris.org` or
`openserverless.org`) and the actual controller database configuration. It
cross-checks all WhiskUser resources against the complete OpenWhisk subjects
and entities databases. Unmanaged namespaces, orphan entities, multiple keys,
custom runtime images, attachments and extra databases remain visible. It
does not assume that CRDs alone account for every OpenWhisk namespace.
Without an explicit namespace, discovery searches the two standard installation
namespaces and rejects ambiguous installations.

The command requires privileged source Kubernetes access and network access
to the internal CouchDB service. Source credentials and full documents are
processed only in memory. The endpoint must be the internal `couchdb` Service,
owned by the selected Whisk; an external or custom CouchDB needs an adapter.
Requests are authenticated GETs with no redirects, bounded streamed responses
and no credentials in URLs. Kubernetes Secret objects are not read by inventory.
The JSON report contains namespace/entity identifiers, runtime kinds, counts,
PVC identities and TLS Secret references, but no passwords, keys, email,
parameters, code, raw annotations or source documents. Save it privately.
The `collector` identity describes the CLI and task checkout executing the
inventory, which can be separate from the installed source tasks.

Keyset pagination checks exact row counts, duplicate/out-of-order rows and
terminal pages, including exact page-size multiples. Database update sequences
and source configuration fingerprints are rechecked. Failed reads, malformed
schemas or concurrent definition changes fail instead of producing a partial
success. This is an observational definition inventory, not a transactionally
consistent data backup or a review of external application dependencies.

Four routes share the same export/restore contract:

* K3s legacy rebuild, including replacing the old K3s installation.
* Kind legacy rebuild, retaining the tool and selecting a compatible cluster.
* Kind to K3s migration, retaining the source until target verification.
* Release update or migration according to the target compatibility contract.

`bundle.ts` builds a **draft**, versioned export manifest covering all discovered
namespaces, entity revisions, identity counts and required backend artifacts.
The target release ID and manifest SHA-256 are pinned in that draft.
Protected platform configuration and all identity keys belong in the actual
export, alongside complete OpenWhisk definitions/code/attachments, versioned
native service data, web assets and persistent-volume recovery material.
System namespace transformation, custom components, undeclared external
dependencies, runtime compatibility and cluster-wide non-OPS resources need
explicit handling. They are never discarded to make the inventory pass.

The export verifier requires exact namespace/entity/artifact coverage,
quiescence declarations, private regular files and streamed byte/hash checks.
Its trusted file-reader implementation must confine relative paths to the
protected export root and reject symlinks. Integrity verification alone does
not prove data semantics or a successful restore, and never permits uninstall.

Current phase status:

* Source discovery, generic inventory and export contract: implemented.
* Native backup bindings, protected per-component collectors and receipt integrity checks: implemented; synthetic validation only.
* Complete backup orchestration, encryption/independent storage and target restore: not implemented.
* Quiescence, restore verification, cluster removal/recreation and cutover: not implemented.

`backupComplete` and `uninstallAllowed` remain false. No existing mutating
`ops update apply` task consumes these reports. Existing `--check`/`--plan`
commands remain the 0.9.0 release comparison workflow; inventory is the first
phase of the separate legacy migration route.

## Native backup adapters

The pinned procedure reference is
[`miki3421/ops-k3s-backup` at `4f9618e`](https://github.com/miki3421/ops-k3s-backup/tree/4f9618e74d196b393a08776989ce2b2968fcb771).
The operator reports that procedure tested on **0.9.0 RC7**. That evidence is
recorded as provenance, not as a test of a different source release, guest
architecture, database major version or migration route. No code is downloaded
from that repository by these tasks.

```sh
# Save inventory and reports outside Git; the directory must be private.
umask 077
ops update inventory --namespace=nuvolaris --json > /private/path/inventory.json
ops update backup-plan --inventory=/private/path/inventory.json --json
```

`backup-plan` rereads the complete definition/identity inventory and refuses
changed resource revisions, code, parameters or credentials, including changes
that keep resource counts equal. Fresh inventory reports carry opaque combined
`definitionsSha256` and `tenantConfigSha256` fingerprints; older reports must
be regenerated. It binds the selected source context, Whisk configuration,
cluster/namespace UIDs, actual PVC UIDs and workload ownership. It resolves
current pod names through StatefulSet, ReplicaSet and Kubegres ownership and
uses actual container mount paths. It does not replace text globally or assume
pod ordinals. PostgreSQL replicas, unknown PVCs, ambiguous mounts and unready
containers remain blockers. No generic raw-copy fallback exists for databases.

The plan covers every inventory-required artifact plus **separate Redis ACLs**.
It maps shared service data for all tenants, rather than selecting a configured
application. Missing collectors and qualification steps remain explicit.

```sh
# This command performs a backup of one component. The destination must be new
# and its existing parent must be private and owned by the current operator.
ops update backup-collect --inventory=/private/path/inventory.json --component=redis-acl --artifacts=/private/path/redis-acl-run --json
```

Implemented collectors are `postgres-data`, `couchdb-data`, `redis-data`,
`redis-acl`, `etcd-data`, `registry-data` and `persistent-volume-recovery`:

* PostgreSQL uses `pg_basebackup` with streamed WAL and `pg_verifybackup`.
* CouchDB copies every append-only `.couch` file, bounded to its open descriptor's
  initial length. Code attachments and extra databases remain in this physical
  backup; transformation and logical restore acceptance are separate work.
* Redis uses replication RDB plus native validation; ACLs are collected separately.
* Application etcd uses native snapshot/status and retains its restore utility.
* File collectors cover known static/operator/Tika volumes and registry blobs,
  resolving actual mounts and excluding active registry uploads. They emit a PVC
  recovery map; database data must come from the independent native collectors.

Commands use existing authorized service containers, explicit container names
and source context. Credentials travel in stdin or existing container
credentials, never command arguments or public output. Native collectors can
create temporary backup files inside those containers; normal shell exit cleans
these up. An abrupt process/container termination may require private operator
cleanup. The source is not frozen and application writes are not stopped.
Collection stops at the first error without retry and retains private diagnostics.
A fresh definition scan runs before and after collection. Existing output
directories are refused; files use mode 0600 beneath mode 0700 directories.
Each run emits only a **partial receipt** and cannot pass whole-backup verification.
These artifacts are private plaintext; encrypted packaging and independently
recoverable storage/keys must be supplied before a final migration backup.

Physical database backups require compatible restore versions. They do not
implement Nuvolaris-to-OpenServerless resource conversion. SeaweedFS matching
binary qualification, populated Milvus native backup, FerretDB backend binding,
complete protected platform/OpenWhisk exports and source quiescence still block
migration. The RC7 recovery guest is ARM64-specific; AMD64 restore and Kind
control-plane recovery remain unqualified. Restoring the original K3s datastore
and binary is recovery of the original installation, not a target-release install.

```sh
ops update backup-verify --inventory=/private/path/inventory.json --receipt=/private/path/receipt.json --artifacts=/private/path/artifacts --json
```

The normalized receipt is `schemaVersion: 1`, `kind: ops-native-backup-receipt`.
It contains `inventorySha256`, the exact plan `source` and `procedure` objects,
`consistency` (`per-component-online` or `quiesced-final`) and `components`.
Every component has `id`, the plan's exact `method`, `scope: all-service-data`,
nonempty `files` (`path`, `bytes`, `sha256`) and `pvcs` (`name`, `uid`). All expected
component IDs must occur exactly once. Each component must cover its mapped PVCs;
`persistent-volume-recovery` must include the complete PVC map. Redis ACLs are
required even when an RDB exists. Relative artifact paths must be unique,
confined, private regular files; symlinks and hardlinks are refused.
The selected source must remain available and match the inventory.

Verification streams every byte and checks declared component/PVC coverage.
A producer's scope or `quiesced-final` declaration is not independent proof of
semantic contents, a write freeze, off-host recoverability or restored application
behavior. Verification always leaves `backupComplete` and `uninstallAllowed`
false. A release-specific restore adapter and isolated acceptance are still required.

Run the relevant tests with bundled tools on PATH:

```sh
bun test update setup/kubernetes/images.test.ts
```

```sh
ops update --check
ops update --plan --json --context=baseline
ops update --plan --channel=preview --manifest=/path/to/lab-release.json
ops update --check --index=https://example.org/releases/index.json --to=0.9.1
```

The planner compares a running Apache baseline installation with one complete
release. It reads Kubernetes resources, runtime configuration, local CLI identity
and the task checkout. It never invokes an existing mutating update task,
executes a database command, reads a Kubernetes Secret, or changes kubeconfig.
Custom `KUBECONFIG` and `--context` are honored. An inventory/read failure is an
error, never an empty or up-to-date installation.

The report includes component switches, slim mode, Kubernetes requirements,
managed template and active pod images, observed digests, PVC identity/status,
runtime kinds, and pinned client changes. Raw Whisk/workload objects, environment
variables, credentials and pod logs are not included in reports. Workloads are
matched by known identity and ownership; a foreign owner or an unmapped managed
workload blocks the plan. The operator and APIs deployed by tasks currently lack
owner references and are explicitly marked `tasks_by_name`.

`aligned` means the selected references, runtime catalog and local clients match.
Mutable preview tags cannot prove identical registry contents. Unknown installed
release IDs do not certify migration compatibility. `automaticApplySupported`
is always false. This phase does not implement arbitrary-version upgrades,
backups, rollback, source-version migration paths, CRD/schema changes, controller
configuration diffs, cluster provisioning/external ingress, or verification of
third-party application images.

## Complete releases

The bundled `releases.json` index is deliberately empty until a complete release
is enrolled. GitHub's latest flag, a CLI snapshot, or a moving task branch is
insufficient to identify the newest compatible platform release. Without a
complete target the command still inventories the cluster and reports
`release_target_unavailable`, rather than claiming the installation is current.

An explicit manifest has this shape (replace illustrative hashes and images):

```json
{
  "schemaVersion": 1,
  "id": "baseline-lab-0.9.0",
  "version": "0.9.0",
  "distribution": "apache",
  "channel": "preview",
  "status": "local",
  "publishedAt": "2026-10-27T00:00:00Z",
  "cli": {
    "version": "0.9.0-incubating+example-snapshot",
    "platform": "linux_amd64",
    "sha256": "<64 lowercase hex digits>"
  },
  "tasks": {
    "repository": "https://github.com/your-account/openserverless-task.git",
    "commit": "<40 lowercase hex digits>"
  },
  "images": { "controller": "registry.example/controller:lab", "invoker": "registry.example/invoker:lab" },
  "runtimes": { "sha256": "<canonical runtimes.json SHA-256>" },
  "kubernetes": { "minVersion": "1.33.0", "maxVersionExclusive": "1.37.0" }
}
```

Include the **entire** target image catalog, including inactive components.
Active images omitted from the target block planning. Hash runtime JSON with
`hash(canonical(parsedJson))` from `releases.ts`; hash manifests and CLI binaries
as bytes. Task revisions must be exact commits. Dirty local tasks are reported
as client changes to preserve before replacement.

Stable manifests must have `status: published`, digest-pinned images, HTTPS CLI
and runtime artifact `url` fields, and no snapshot/dev/RC identity. Preview
manifests also require pinned CLI checksums, task commits and runtime hashes.
One manifest targets one CLI OS/architecture; incompatible platforms block.

An external or bundled index has `schemaVersion: 1` and a `releases` array:

```json
{
  "schemaVersion": 1,
  "releases": [{
    "id": "0.9.1",
    "version": "0.9.1",
    "channel": "stable",
    "status": "published",
    "publishedAt": "2026-10-27T00:00:00Z",
    "manifest": "0.9.1-linux-amd64.json",
    "sha256": "<manifest byte SHA-256>"
  }]
}
```

Selection uses semantic version precedence, then publication time, within the
explicit channel. Withdrawn entries (`withdrawn: true`) are excluded. The
manifest checksum and identity must match the index. Relative manifests resolve
against the index location. HTTPS downloads use bounded GETs and reject
redirects and credential-bearing URLs. A user-provided index is an explicit
trust source; checksums provide consistency, not publisher authentication.

### Laboratory catalog

A separate **local** index can declare `"scope": "lab"`. Its entries must all be
`channel: preview`, `status: local` and include a `runtimes` path relative to the
index. The planner verifies both the manifest's byte checksum and that runtime
file's canonical checksum. Select it explicitly with
`--channel=preview --index=/path/to/lab/index.json`; `--to` can pin one entry.
Local entries never enter the normal published-release selection. HTTPS lab
indexes, remote lab manifests and remote lab runtime files are rejected.

Lab targets describe an existing installation and may depend on unpublished
images or an already installed CLI. They do not certify fresh installation,
registry availability, or a distributable Apache release. Artifact publication
is a separate step before automatic updates can be implemented.

Keep release metadata separate from the task revision it describes: first
commit the task implementation, then reference that existing commit from a
later catalog commit. A checkout containing newer catalog metadata will correctly
report a task revision difference; use the pinned task checkout with the catalog
passed through `--index` to verify an aligned installation. Do not hide this
difference or use a moving branch as the task pin.

## Blockers and boundaries

Persistent service changes (including PostgreSQL, CouchDB, FerretDB, Redis,
Milvus, Kafka and SeaweedFS) require review. A major change inferable from tags
is classified `migration_required`; an opaque version or same-major switch
remains `review_required`. The planner does not query database internals and
does not certify same-major data compatibility. Runtime catalog changes also
require compatibility review for existing actions.

Legacy installations without `spec.images` require a compatible catalog-aware
operator and explicit adoption first. Missing/unready managed resources,
unbound PVCs, incompatible Kubernetes, missing client identity, and observed
digest mismatches also block. The report cannot guarantee a transactionally
consistent cluster snapshot; recheck before any future execution phase.

The JSON report contains a SHA-256 of its canonical content (excluding the hash
field) for review correlation. It is not an executable or signed authorization.
The existing `ops update cli/operator/runtimes/apply/secrets` commands retain
their independent behavior and can mutate state; they do not consume this plan.

Run focused tests with the Bun bundled in `ops`:

```sh
bun test update setup/kubernetes/images.test.ts
OPS_TEST_BINARY=/path/to/installed/ops bun test update/plan.test.ts
```
