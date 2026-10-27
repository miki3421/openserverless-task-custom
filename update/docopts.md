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
  --namespace=<namespace> Installation namespace [default: openserverless].
  --instance=<instance>   Whisk resource name [default: controller].
  --json                  Print a structured report.
```

Use `--option=value` for options with values. Local paths are resolved from
the caller's directory. The bundled index starts empty: no complete platform
release is enrolled yet. See [README.md](README.md) for manifest requirements.

Exit codes: `0` means comparison completed; `3` means a target or compatibility
blocker; `1` means options, metadata, or required reads failed. The task runner
may wrap a nonzero status; inspect `status` and `blockers` in JSON reports.

## Existing commands

`cli`, `operator`, `runtimes`, `apply`, and `secrets` retain their existing
behavior. These commands can change the installation or local configuration;
they are independent of the read-only planner and do not execute its plan.
