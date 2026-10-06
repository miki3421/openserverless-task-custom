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
# Tasks `ops backup cluster`

Inspect whether the current Kubernetes cluster is ready for a recoverable,
off-cluster backup.

## Synopsis

```text
Usage:
  cluster plan [--json]
```

## Commands

```text
plan    Read-only inventory of persistent volumes and backup prerequisites.
```

The plan does not create backups or change cluster resources. It reports
storage sources, Velero and backup-location readiness, and coverage gaps. A
successful plan is not proof that application data or the Kubernetes control
plane can be restored.

## Options

```text
--json    Print machine-readable JSON.
```

The first version intentionally has no `create` or `restore` command. Those
commands require a configured destination outside the cluster and a tested
backup path for K3s datastore/token data and local-path/hostPath volumes.
