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

# Baseline laboratory release catalog

This catalog records the existing Apache-based 0.9.0 baseline as a local preview
target, `baseline-0.9.0-lab.20261027`. It is not an official Apache release or an
installable distribution. The normal published index at `update/releases.json`
is separate and remains empty.

The manifest pins the CLI by binary SHA-256 and version, tasks by full commit
`14a6eca5a40d274dfe43b84b0a2f1e9d66cb7e36`, all 39 platform image references and
the canonical runtime catalog hash. The full runtime catalog is included, with
14 kinds. The Kubernetes range is deliberately limited to the observed patch
version, 1.36.4; this is not certification of other Kubernetes versions or
distributions.

## Contents

- `index.json`: local preview selection and manifest checksum.
- `baseline-0.9.0-20261027/manifest.json`: the pinned comparison target.
- `baseline-0.9.0-20261027/runtimes.json`: complete runtime catalog.
- `baseline-0.9.0-20261027/observations.json`: sanitized component flags,
  installation mode and observed CRI image IDs for 27 image keys. The other
  12 references are recorded as catalog entries without pulling their images.
- `baseline-0.9.0-20261027/SHA256SUMS`: byte checksums for these three files.

Observations contain no cluster UID, address, credentials or tenant data.
Observed CRI image IDs are not claimed to be registry manifest digests.
The profile is supporting evidence, not a migration or installation policy.

## Read-only verification

Keep the catalog checkout and pinned task checkout separate. For example:

```sh
git clone --branch feature/release-manifest-0.9.0 https://github.com/miki3421/openserverless-task-custom.git ops-release-catalog
git -C ops-release-catalog worktree add --detach ../ops-release-tasks 14a6eca5a40d274dfe43b84b0a2f1e9d66cb7e36
OPS_ROOT="$(pwd)/ops-release-tasks" ops update --plan --channel=preview --index="$(pwd)/ops-release-catalog/update/lab/index.json"
```

Use the baseline kubeconfig or an explicit `--context=<context>`.
`--check`, `--to=baseline-0.9.0-lab.20261027` and `--json` are also supported.
A normal published-release query cannot select this local target.
Using the newer catalog checkout itself as `OPS_ROOT` will correctly report
its task revision difference; it does not hide newer local code.

Verify the bundle independently:

```sh
cd ops-release-catalog/update/lab/baseline-0.9.0-20261027
sha256sum --check SHA256SUMS
```

## Before making a distributable release

The operator, Admin API and streamer still use `localhost/...` images loaded
on the baseline. Those images have not been published by this work. The
manifest's CLI identifies an installed binary, with no enrolled download URL.
Preview image tags may be mutable; registry availability was not checked.
No database upgrade, application execution, fresh installation or ADV test
was performed to enroll this catalog.

A distributable release will need available CLI and runtime artifacts, image
publication with registry manifest digest pins, and validated installation and
source-version migration paths. A new reviewed manifest must describe those
artifacts; do not relabel this local snapshot as a published or stable release.
Automatic update execution remains unimplemented.
