<!--
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

# Platform image catalog

`opsroot.json` / `config.images` selects the platform images for the release.
The matching operator branch consumes the effective catalog persisted in
`Whisk.spec.images`. `ops setup kubernetes instance` and `instance-update`
render this field automatically. Local `IMAGES_*` configuration overrides take
precedence; for example, `IMAGES_OPERATOR` selects a locally built operator.
The legacy controller/invoker image fields are kept synchronized.

To inspect the effective catalog without accessing Kubernetes:

```sh
ops setup kubernetes images
```

From the task source directory, the underlying read-only command is:

```sh
bun setup/kubernetes/images.ts catalog
```

All catalog references require a tag or SHA-256 digest. A malformed or empty
override fails rendering. The generated Whisk JSON (also valid YAML) is written
atomically with private file permissions, because the full CR contains secrets.

The additional keys preserve the versions already used by baseline manifests.
The formerly unused generic ingress entry is aligned with the existing cloud
manifest (v1.8.1); Kind/EKS keep their existing v1.5.1 image under `ingress_kind`.
Separate admission-helper, OpenShift CouchDB and Kafka BusyBox entries preserve
their respective versions. Milvus retains the catalog's v2.5.27 selection.

Some images belong to specialized existing catalogs: action runtime images stay
in `runtimes.json`, user action/workflow images stay with their applications,
and Dockerfile base images remain build dependencies. Existing external ingress
controllers and certificate managers are not adopted or upgraded.

This task branch requires the companion operator branch
`feature/centralize-images-0.9.0`. Until that operator is published, build it
locally, load it into the test cluster, and select it through `IMAGES_OPERATOR`.
The Apache image pinned by the default catalog does not yet implement this
feature. Existing Whisks without the catalog retain legacy operator behavior.

Centralizing an image does not make database major versions interchangeable.
Keep current references for this increment; data migrations belong to the
future coordinated `ops update` workflow.

```sh
bun test setup/kubernetes/images.test.ts
```

Local validation on 2026-10-27: all five task tests passed, including registry
ports/digests, overrides, malformed catalogs, idempotent rendering and private
output permissions. The actual task renderer generated the 39-entry catalog
used by the existing K3s baseline. The companion operator passed 143 Python
tests, image routing/no-op checks, and all 15 Alpha/Beta application checks.
