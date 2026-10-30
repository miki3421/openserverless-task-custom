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

import { isAbsolute } from "node:path";
import { isIP } from "node:net";

// The caller must qualify the isolated guest, source archive and running binary.
// An export filtered by platform may still contain multi-platform index objects.
export function platformImageImportArgs(archive: string, platform: string): string[] {
  if (!isAbsolute(archive) || /[\x00-\x1f]/.test(archive) || archive.split("/").includes(".."))
    throw new Error("invalid_offline_image_archive");
  if (!["linux/amd64", "linux/arm64"].includes(platform)) throw new Error("unsupported_offline_image_platform");
  return ["ctr", "--namespace", "k8s.io", "images", "import", "--platform", platform, archive];
}

export async function waitRegisteredNode(
  read: () => Promise<any | undefined>, expected: { name: string; ip: string },
  options: { timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<any> {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(expected.name) || !isIP(expected.ip))
    throw new Error("invalid_offline_guest_node_identity");
  const timeout = options.timeoutMs ?? 180000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600000) throw new Error("invalid_node_registration_timeout");
  const now = options.now ?? Date.now, sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + timeout;
  while (now() < deadline) {
    const node = await read(); // Only an absent object is retried; API/auth errors propagate.
    if (node !== undefined) {
      if (node?.kind !== "Node" || node.metadata?.name !== expected.name || !node.metadata?.uid)
        throw new Error("offline_guest_node_identity_mismatch");
      const ips = (node.status?.addresses ?? []).filter((a: any) => a.type === "InternalIP").map((a: any) => a.address);
      if (ips.length && !ips.includes(expected.ip)) throw new Error("offline_guest_node_address_mismatch");
      if (ips.includes(expected.ip)) return node;
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(1000, remaining));
  }
  throw new Error("offline_guest_node_registration_timeout");
}
