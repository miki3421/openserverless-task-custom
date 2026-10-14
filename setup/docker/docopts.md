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
# Docker / Kind setup

```text
Usage:
  docker <command> [<args>...]
```

Commands:
  userns    Prepare existing Kind nodes for isolated rootless builder jobs.

The existing Docker setup commands remain available. `cluster` prepares new
nodes automatically and `create` also prepares an existing cluster.

`ops setup docker userns` requires Docker access to the local Kind nodes. It
installs a node service that maintains a private, read-only sysfs mount across
node restarts and makes Kind's hook directory traversable. It does not alter
worker security settings. It requires a node/runtime supporting Kubernetes pod
user namespaces (tested with Kubernetes 1.33.1 / containerd 2.1.1).

The admin-api builder security fix and the BuildKit process-sandbox configuration
must also be deployed. This command does not upgrade Kubernetes or the builder.
