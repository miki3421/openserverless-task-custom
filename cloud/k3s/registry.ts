// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

export const REGISTRY_PATH = "/etc/rancher/k3s/registries.yaml";
export const REGISTRY_CONFIG = `# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

# OPS internal registry, exposed on each node through NodePort 32000.
# Credentials stay in the Pod imagePullSecret, not in this file.
mirrors:
  "openserverless-registry-svc:5000":
    endpoint:
      - "http://127.0.0.1:32000"
`;

export type RemoteResult = {code: number; stdout: string; stderr: string};
export type Remote = (target: string, command: string, input?: string) => Promise<RemoteResult>;

const normalize = (value: string) => value.replace(/\r\n/g, "\n").trim();

export function registryConfigAction(current: string): "install" | "unchanged" {
  if (!current.trim()) return "install";
  if (normalize(current) === normalize(REGISTRY_CONFIG)) return "unchanged";
  throw new Error(
    `${REGISTRY_PATH} already contains a custom configuration. ` +
    "OPS will not overwrite it; add an exact mirror for " +
    '"openserverless-registry-svc:5000" to "http://127.0.0.1:32000" manually.'
  );
}

function targetFor(server: string, user: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(server)) throw new Error("Invalid K3s server name or address");
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(user)) throw new Error("Invalid SSH user name");
  return `${user}@${server}`;
}

export async function configureRegistry(server: string, user: string, remote: Remote) {
  const target = targetFor(server, user);
  const read = await remote(
    target,
    `if sudo test -e ${REGISTRY_PATH}; then sudo cat ${REGISTRY_PATH}; fi`,
  );
  if (read.code !== 0) throw new Error(`Unable to inspect ${REGISTRY_PATH}: ${read.stderr.trim()}`);
  if (registryConfigAction(read.stdout) === "unchanged") {
    console.log("K3s registry mirror is already configured.");
    return "unchanged";
  }

  const write = await remote(
    target,
    `sudo sh -c 'set -eu; mkdir -p /etc/rancher/k3s; ` +
    `if test -s ${REGISTRY_PATH}; then exit 73; fi; ` +
    `tmp=$(mktemp ${REGISTRY_PATH}.tmp.XXXXXX); trap "rm -f $tmp" EXIT; ` +
    `cat >"$tmp"; chmod 0644 "$tmp"; mv "$tmp" ${REGISTRY_PATH}; trap - EXIT'`,
    REGISTRY_CONFIG,
  );
  if (write.code === 73) throw new Error(`${REGISTRY_PATH} changed while OPS was configuring it; no file was overwritten`);
  if (write.code !== 0) throw new Error(`Unable to write ${REGISTRY_PATH}: ${write.stderr.trim()}`);

  const restart = await remote(
    target,
    "if sudo systemctl is-active --quiet k3s; then sudo systemctl restart k3s; fi",
  );
  if (restart.code !== 0) throw new Error(`Unable to reload K3s registry configuration: ${restart.stderr.trim()}`);
  console.log("K3s registry mirror configured for the OPS internal registry only.");
  return "installed";
}

const ssh: Remote = async (target, command, input) => {
  const child = Bun.spawn(["ssh", "-oStrictHostKeyChecking=no", target, command], {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {code, stdout, stderr};
};

if (import.meta.main) {
  try {
    if (process.argv[2] !== "configure" || !process.argv[3]) {
      throw new Error("Usage: registry.ts configure <server> [user]");
    }
    await configureRegistry(process.argv[3], process.argv[4] || "root", ssh);
  } catch (error) {
    console.error(`ERROR: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
