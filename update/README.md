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
