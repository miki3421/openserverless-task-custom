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

import { $ } from "bun";

type JsonObject = Record<string, any>;

export type VolumeSummary = {
  name: string;
  phase: string;
  storageClass: string;
  claim: string;
  source: string;
};

export type BackupPlan = {
  context: string;
  nodeCount: number;
  volumes: VolumeSummary[];
  velero: { installed: boolean; ready: boolean; locations: string[] };
  blockers: string[];
  warnings: string[];
};

function sourceType(spec: JsonObject = {}): string {
  for (const field of ["csi", "hostPath", "local", "nfs", "awsElasticBlockStore", "azureDisk", "gcePersistentDisk"]) {
    if (spec[field]) return field;
  }
  return "unknown-or-inline";
}

export function buildPlan(input: {
  context: string;
  nodes: JsonObject[];
  pvs: JsonObject[];
  veleroDeployment?: JsonObject | null;
  backupLocations?: JsonObject[];
}): BackupPlan {
  const volumes = input.pvs.map((pv) => ({
    name: pv.metadata?.name ?? "unknown",
    phase: pv.status?.phase ?? "unknown",
    storageClass: pv.spec?.storageClassName ?? "",
    claim: pv.spec?.claimRef
      ? `${pv.spec.claimRef.namespace ?? "?"}/${pv.spec.claimRef.name ?? "?"}`
      : "",
    source: sourceType(pv.spec),
  }));

  const veleroDeployment = input.veleroDeployment ?? null;
  const desired = Number(veleroDeployment?.spec?.replicas ?? 0);
  const ready = Number(veleroDeployment?.status?.availableReplicas ?? 0);
  const locations = (input.backupLocations ?? []).map((location) => {
    const name = location.metadata?.name ?? "unknown";
    const namespace = location.metadata?.namespace ?? "velero";
    const phase = location.status?.phase ?? "unknown";
    return `${namespace}/${name}:${phase}`;
  });

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (volumes.some((volume) => ["hostPath", "local"].includes(volume.source))) {
    blockers.push("Local/hostPath persistent volumes need a node-level backup path; Velero file-system backup alone does not cover them.");
  }
  if (volumes.some((volume) => volume.phase !== "Bound")) {
    warnings.push("At least one persistent volume is not Bound; check whether it contains data that must be preserved.");
  }
  if (!veleroDeployment) {
    blockers.push("Velero is not installed in namespace velero.");
  } else if (desired === 0 || ready < desired) {
    blockers.push(`Velero is not ready (${ready}/${desired} available replicas).`);
  }
  if (!locations.length) {
    blockers.push("No Velero BackupStorageLocation is configured; the backup destination must be outside this cluster.");
  } else if (locations.some((location) => !location.endsWith(":Available"))) {
    blockers.push("At least one Velero BackupStorageLocation is not Available.");
  }
  blockers.push("K3s datastore, server token and node configuration require a separate control-plane backup and restore procedure.");
  warnings.push("Volume-level backups do not guarantee application-consistent database backups; validate database-native dumps and restore tests.");
  if (locations.length) {
    warnings.push("An Available BackupStorageLocation is not proof that its storage is outside this cluster; verify the endpoint and failure domain.");
  }

  return {
    context: input.context,
    nodeCount: input.nodes.length,
    volumes,
    velero: { installed: Boolean(veleroDeployment), ready: Boolean(veleroDeployment && desired > 0 && ready >= desired), locations },
    blockers,
    warnings,
  };
}

async function kubectlJson(args: string[], optional = false): Promise<JsonObject | null> {
  const result = await $`kubectl ${args}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    if (optional) return null;
    throw new Error(`kubectl ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  try {
    return JSON.parse(result.stdout.toString());
  } catch {
    throw new Error(`kubectl ${args.join(" ")} returned invalid JSON`);
  }
}

async function plan(): Promise<BackupPlan> {
  const contextResult = await $`kubectl config current-context`.quiet();
  const context = contextResult.stdout.toString().trim();
  const [nodes, pvs, deployment, locations] = await Promise.all([
    kubectlJson(["get", "nodes", "-o", "json"]),
    kubectlJson(["get", "pv", "-o", "json"]),
    kubectlJson(["-n", "velero", "get", "deployment", "velero", "-o", "json"], true),
    kubectlJson(["get", "backupstoragelocations.velero.io", "-A", "-o", "json"], true),
  ]);

  return buildPlan({
    context,
    nodes: nodes?.items ?? [],
    pvs: pvs?.items ?? [],
    veleroDeployment: deployment,
    backupLocations: locations?.items ?? [],
  });
}

async function main() {
  const command = process.argv[2];
  if (command !== "plan") {
    console.error("Usage: cluster.ts plan [--json]");
    process.exit(2);
  }

  try {
    const result = await plan();
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Kubernetes context: ${result.context || "unknown"}`);
    console.log(`Nodes: ${result.nodeCount}`);
    console.log(`Velero: ${result.velero.installed ? (result.velero.ready ? "ready" : "not ready") : "not installed"}`);
    console.log(`Backup locations: ${result.velero.locations.length ? result.velero.locations.join(", ") : "none"}`);
    console.log("Persistent volumes:");
    if (!result.volumes.length) console.log("  none found");
    for (const volume of result.volumes) {
      console.log(`  ${volume.name}: ${volume.phase}; source=${volume.source}; class=${volume.storageClass || "none"}; claim=${volume.claim || "none"}`);
    }
    for (const blocker of result.blockers) console.log(`BLOCKER: ${blocker}`);
    for (const warning of result.warnings) console.log(`WARNING: ${warning}`);
    console.log("This is a read-only preflight; it does not create or verify a backup.");
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
