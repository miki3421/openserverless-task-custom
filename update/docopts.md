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
# Tasks `ops update`

Inspect the installed platform and compare it with a pinned release.
`--check` and `--plan` only read the cluster. They never execute an upgrade.

```text
Usage:
  update inventory [--namespace=<namespace>] [--instance=<instance>] [--context=<context>] [--json]
  update backup-plan --inventory=<file> [--json]
  update backup-collect --inventory=<file> --component=<id> --artifacts=<directory> [--json]
  update backup-verify --inventory=<file> --receipt=<file> --artifacts=<directory> [--json]
  update (--check | --plan) [--manifest=<file> | --index=<source>] [--to=<release>] [--channel=<channel>] [--context=<context>] [--namespace=<namespace>] [--instance=<instance>] [--json]
  update (cli | operator | runtimes | apply | secrets)
```

## Options

```text
  --check                 Summarize installed state and available changes.
  --plan                  Also list each proposed component change.
  --manifest=<file>       Explicit release manifest (local file or HTTPS).
  --index=<source>        Release index (local file or HTTPS).
  --to=<release>          Exact release ID; otherwise select latest in the channel.
  --channel=<channel>     stable or preview [default: stable].
  --context=<context>     Kubernetes context; does not switch the current context.
  --namespace=<namespace> Installation namespace; plans default to openserverless, inventory auto-detects.
  --instance=<instance>   Whisk resource name [default: controller].
  --json                  Print a structured report.
  --inventory=<file>      Protected source inventory JSON; selects the source context and identity.
  --receipt=<file>        Protected normalized native backup receipt.
  --artifacts=<directory> Private root containing collected artifacts.
  --component=<id>        Explicitly selected native backup component; never collects other components implicitly.
```

Use `--option=value` for options with values. Local paths are resolved from
the caller's directory. The bundled index starts empty: no complete platform
release is enrolled yet. See [README.md](README.md) for manifest requirements.

Exit codes: `0` means comparison completed; `3` means a target or compatibility
blocker; `1` means options, metadata, or required reads failed. The task runner
may wrap a nonzero status; inspect `status` and `blockers` in JSON reports.

## Existing commands

`inventory` discovers Nuvolaris or OpenServerless source resources, reads every
OpenWhisk subject and entity with pagination, and compares them with WhiskUser
resources. With no namespace argument it checks the two standard installation
namespaces and rejects ambiguous installations; specify a namespace for a custom
installation. It reads privileged source configuration and application documents
in memory, and sends authenticated GET requests to the owned internal CouchDB
service. It must run where that service IP is reachable. It never invokes an
action or prints credentials, code, parameters, or raw documents. The JSON report
contains application metadata and should be saved in a protected location.

Inventory completion is not a backup or a restore test. Source removal remains
blocked. The source CLI and installation stay unchanged. Kubernetes read failures,
unsupported schemas, incomplete pages and changes to source definitions fail the
command. Data exporters, quiescence, restore and cluster provisioning are separate
migration phases that are not implemented by this command.

`backup-plan` binds the explicit inventory to live source configuration, the
selected Kubernetes context, cluster identity, workload owners and actual PVC
mounts. It maps the pinned native backup procedure without running collectors.
Its JSON includes collection and migration blockers; exit code `3` means a
blocked plan. Source credentials and application documents are never printed.

`backup-verify` rechecks those source identities and verifies a normalized
receipt against every required artifact category, including separate Redis
ACLs, exact PVC coverage and private artifact byte counts and SHA-256 hashes.
It checks declared scope, not the semantics of database contents, quiescence,
encryption, independent storage or a working restore. An unchanged source must
remain accessible for this receipt verification phase. See README for the
receipt contract. Neither command runs backup, restore or source removal.

`backup-collect` performs the selected native backup and writes private artifacts,
diagnostics and a partial receipt in a fresh directory beneath a private parent.
It may create temporary backup files inside the selected service container;
these are removed on normal shell exit. It never freezes services or restores
data. Read the supported components and limitations in README before use.

`cli`, `operator`, `runtimes`, `apply`, and `secrets` retain their existing
behavior. These commands can change the installation or local configuration;
they are independent of the read-only planner and do not execute its plan.
