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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Run only against nodes returned by Kind and independently verify their label.
function run(argv: string[], input?: string): string {
  const result = Bun.spawnSync(argv, {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${argv[0]} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

const cluster = process.argv[2];
if (!cluster || !/^[a-z0-9][a-z0-9-]*$/.test(cluster)) {
  console.error("Usage: bun kind-userns.ts <kind-cluster-name>");
  process.exit(1);
}
try {
  const nodes = run(["kind", "get", "nodes", "--name", cluster]).split(/\s+/).filter(Boolean);
  if (nodes.length === 0) throw new Error(`No Kind nodes found for ${cluster}`);
  const script = readFileSync(fileURLToPath(new URL("./kind-userns.sh", import.meta.url)), "utf8");
  const unit = readFileSync(fileURLToPath(new URL("./ops-kind-userns.service", import.meta.url)), "utf8");
  // Complete validation before changing any node.
  for (const node of nodes) {
    const info = JSON.parse(run(["docker", "inspect", node]))[0];
    if (info.Config.Labels?.["io.x-k8s.kind.cluster"] !== cluster || !info.State.Running) {
      throw new Error(`${node} is not a running node of Kind cluster ${cluster}`);
    }
  }
  for (const node of nodes) {
    run(["docker", "exec", "--user", "0", "-i", node, "sh", "-c",
      "install -d -m 0755 /usr/local/libexec; cat > /usr/local/libexec/ops-kind-userns; chmod 0755 /usr/local/libexec/ops-kind-userns"], script);
    run(["docker", "exec", "--user", "0", "-i", node, "sh", "-c",
      "cat > /etc/systemd/system/ops-kind-userns.service; chmod 0644 /etc/systemd/system/ops-kind-userns.service"], unit);
    run(["docker", "exec", "--user", "0", node, "systemctl", "daemon-reload"]);
    run(["docker", "exec", "--user", "0", node, "/usr/local/libexec/ops-kind-userns"]);
    run(["docker", "exec", "--user", "0", node, "systemctl", "enable", "--now", "ops-kind-userns.service"]);
    console.log(`Prepared ${node}: read-only node sysfs; builder isolation unchanged.`);
  }
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
