<!-- Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements. See the NOTICE file distributed with this
work for additional information regarding copyright ownership. The ASF
licenses this file to You under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance with the License.
You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
License for the specific language governing permissions and limitations
under the License. -->

# Build custom action runtimes without Docker

`ops ide build [image] [--force] [--dry-run] [--mode=<mode>]` builds dependency
images through the authenticated System API and its Kubernetes BuildKit Job.
Docker is not required on the machine running this command.

## Project recipe

Add an object (or an array for multiple images) to the existing `openserverless`
section of `package.json`:

```json
{
  "openserverless": {
    "build": {
      "image": "${BRACCHI_EMAIL_DOCKER_IMAGE}",
      "source": "docker.io/apache/openserverless-runtime-python:v3.12-2506091954",
      "kind": "python",
      "requirements": "requirements.txt",
      "registryUrl": "http://127.0.0.1:32000",
      "registryAuthHost": "openserverless-registry-svc:5000",
      "kubeNamespace": "openserverless",
      "platform": "linux/arm64",
      "timeoutSeconds": 1800
    }
  }
}
```

Keep the project's other JSON keys. Configuration strings support the same
environment expansion as action directives. There are no credentials in the
recipe. `registryUrl` is the registry origin reachable from the CLI machine;
`registryAuthHost` selects the matching entry in a Docker credential store or
the Kubernetes `registry-pull-secret`. `apiHost` can override the System API
origin; otherwise the existing login context is used.

Choose an image name compatible with the authenticated System API user. For
the development namespace used by Bracchi:

```bash
export BRACCHI_EMAIL_DOCKER_IMAGE=openserverless-registry-svc:5000/devcargoorderentry:bracchi-email-v1
ops ide login
ops ide build
ops ide deploy
```

The API publishes to its configured `registry_host/<username>:<tag>`. The
NodePort above exposes the same registry for the CLI's manifest check. For
production use the production namespace and registry, with the existing Docker
build entry point if desired.

The public command is owned by `ide/opsfile.yml`, not by an embedded CLI
dispatcher. Changing task versions is sufficient to update it.

## Automatic build during deploy

Before updating actions, `ops ide deploy` reads the existing `#--docker` and
`//--docker` directives, expands their environment variables, and checks the
registry manifest. A successful check reuses the image. Only HTTP 404 starts
`ops ide build <image>`; authentication, TLS, permission, and network errors stop
deployment. A missing image without a matching recipe also stops deployment.
Each build is awaited until the returned Kubernetes Job completes and the
image manifest can be read. Failed or timed-out builds stop deployment.

Full package scans preflight their discovered action sources; single-action
deploys and the development watcher use the same guard. Source directives and
OpenWhisk action annotations are preserved. Actions using ordinary `--kind`
runtimes are unaffected. Wskdeploy YAML manifests are not rewritten or
automatically built by this guard; use `ops ide build` before deploying those.

`ops ide build --force` explicitly rebuilds an existing tag. Use versioned tags
to avoid stale runtime caches. `--dry-run` performs no registry or API requests
and starts no build or action update.

## Cluster prerequisites

- A System API whose Python builder installs dependencies with pip. The fork
  `miki3421/openserverless-admin-api`, branch `codex/python-build`, includes this
  change; the previous API used `/bin/extend`, absent from the inspected Python
  runtimes.
- A working internal registry and matching `registry-pull-secret`.
- Kubernetes access to read build Jobs and registry credentials. Set
  `OPS_BUILD_KUBE_NAMESPACE` if the deployment uses a legacy namespace such as
  `nuvolaris`; a recipe's `kubeNamespace` takes precedence.
- A working native BuildKit Job on the cluster architecture. The API does not
  accept a cross-compilation platform. The optional recipe platform is checked
  against node architectures before submission.
- Containerd configured to pull from the registry, including HTTP transport
  and authentication for the hostname actually used in the action image.

For the current single-node k3s server, the logical image registry can be
mapped to its local NodePort in `/etc/rancher/k3s/registries.yaml`:

```yaml
mirrors:
  "openserverless-registry-svc:5000":
    endpoint:
      - "http://127.0.0.1:32000"
```

Merge with any existing configuration. K3s requires a restart to load this
configuration; the operator must schedule that operation. Keep the logical
image hostname matching the existing `registry-pull-secret` and ensure action
Pods reference that Secret. A local NodePort endpoint is suitable only on nodes
that expose the registry; use a reachable registry address for other clusters.

The legacy Docker + kind deployment can continue building with `build.sh` and
using `127.0.0.1:32000/bracchi-email:latest`. When that image already exists,
deploy does not call the System API and does not rename it. If it is missing,
the old image name is not a valid new System API target; rebuild it with the
existing Docker workflow or select a namespace-based image name explicitly.

The builder extends a base runtime using a dependency file; it does not upload
the repository or execute an arbitrary project Dockerfile. Keep application
code in action ZIPs. OS package additions and extra Dockerfile instructions
require a separately prepared base runtime.

## Install the fork on the client server

After the branch is published:

```bash
export OPS_REPO=https://github.com/miki3421/openserverless-task-bracchi
export OPS_BRANCH=codex/ide-build
export KUBECONFIG="$HOME/.ops/tmp/kubeconfig"
ops -update
```

Persist these exports in the server's chosen shell configuration when ready.
Do not reset the entire `.ops` directory: it contains the current kubeconfig.
The new task checkout does not include previously hand-edited `cloud k3s
install` files; preserve those separately before changing task versions.

Build and publish the companion API from its existing GitHub image workflow,
then pin that published image in the cluster's System API deployment. Do not
run the first application build until that upgrade and registry setup are
complete. No server deployment is performed by installing the task fork.

## Delivery status

Implementation and source review only. Automated tests and a live build were
not run for this change. Exercise missing/present images, bad registry
credentials, failed Jobs, dry-run, and legacy kind in staging before production.
