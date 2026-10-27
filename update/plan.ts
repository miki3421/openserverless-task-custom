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

import { resolve } from "node:path";
import { collect, type Inventory, type Slot } from "./inventory";
import { canonical, hash, compareVersions, selectTarget, type Release, type Channel } from "./releases";

export interface Change {
  component: string; action: "rollout" | "catalog_only" | "wait_for_rollout" | "migration_required" | "review_required" | "adopt_catalog";
  current: string[]; target: string; consumers: string[]; reason: string;
}
export interface Plan {
  schemaVersion: 1; mode: "check" | "plan"; readOnly: true; automaticApplySupported: false;
  status: "aligned" | "changes_available" | "blocked"; inventory: Inventory;
  target: { release: Release | null; manifestSha256: string | null; selection: string; reason?: string };
  changes: Change[]; clientChanges: { component: string; current: string | null; target: string; reason: string }[];
  blockers: string[]; warnings: string[]; planSha256: string;
}
export function normalizedImage(reference: string): string {
  const [tagged, digest] = reference.split("@");
  const last = tagged.lastIndexOf("/");
  const colon = tagged.lastIndexOf(":");
  let repository = colon > last ? tagged.slice(0, colon) : tagged;
  const tag = colon > last ? tagged.slice(colon + 1) : "";
  const first = repository.split("/")[0];
  if (!first.includes(".") && !first.includes(":") && first !== "localhost") repository = "docker.io/" + repository;
  repository = repository.replace(/^index\.docker\.io\//, "docker.io/");
  if (repository.startsWith("docker.io/") && repository.split("/").length === 2)
    repository = repository.replace("docker.io/", "docker.io/library/");
  return repository + (digest ? "@" + digest : ":" + tag);
}
const DATABASES = new Set(["couchdb", "couchdb_openshift", "pgvector", "redis", "etcd", "milvus", "pulsar", "zookeeper", "ferretdb", "kvrocks", "registry", "kafka", "seaweedfs"]);
export function majorVersion(key: string, reference: string): number | null {
  const noDigest = reference.split("@")[0];
  const tag = noDigest.lastIndexOf(":") > noDigest.lastIndexOf("/") ? noDigest.slice(noDigest.lastIndexOf(":") + 1) : "";
  const match = key === "pgvector" ? tag.match(/(?:^|[-_])pg(\d+)(?:[-_]|$)/) || tag.match(/^(\d+)\./)
    : tag.match(/^v?(\d+)(?:\.|$)/);
  return match ? Number(match[1]) : null;
}
export function buildPlan(inventory: Inventory, target: Plan["target"], mode: Plan["mode"]): Plan {
  const changes: Change[] = [], clientChanges: Plan["clientChanges"] = [];
  const warnings = [...inventory.warnings], blockers: string[] = [];
  const release = target.release;
  if (!release) blockers.push("release_target_unavailable");
  if (inventory.warnings.some(value => /^(unmapped_|missing_managed_|unverified_workload_)/.test(value)))
    blockers.push("incomplete_managed_image_inventory");
  if (!inventory.installation.releaseId) warnings.push("installed_release_id_unknown; source-version compatibility is not certified");
  for (const workload of inventory.workloads) {
    const podSlots = workload.slots.flatMap(slot => slot.running);
    if (podSlots.some(pod => !pod.ready)) blockers.push("workload_not_ready:" + workload.kind + "/" + workload.name);
    if (workload.replicas && workload.kind !== "CronJob" &&
        (workload.readyReplicas ?? 0) < workload.replicas)
      blockers.push("workload_not_ready:" + workload.kind + "/" + workload.name);
    if (workload.replicas && workload.kind !== "CronJob" && !podSlots.length)
      blockers.push("running_images_unavailable:" + workload.kind + "/" + workload.name);
  }
  for (const volume of inventory.volumes) if (volume.phase !== "Bound") blockers.push("volume_not_bound:" + volume.name);
  if (release) {
    try {
      if (compareVersions(inventory.cluster.kubernetesVersion, release.kubernetes.minVersion) < 0 ||
          (release.kubernetes.maxVersionExclusive &&
           compareVersions(inventory.cluster.kubernetesVersion, release.kubernetes.maxVersionExclusive) >= 0))
        blockers.push("incompatible_kubernetes_version");
    } catch { blockers.push("unknown_kubernetes_version"); }
    if (inventory.client.platform !== release.cli.platform) blockers.push("incompatible_cli_platform");
    if (!inventory.client.cliVersion || !inventory.client.cliSha256) blockers.push("cli_identity_unavailable");
    else if (inventory.client.cliVersion !== release.cli.version || inventory.client.cliSha256 !== release.cli.sha256)
      clientChanges.push({ component: "cli", current: inventory.client.cliVersion, target: release.cli.version,
        reason: "CLI version or binary checksum differs from the pinned release" });
    if (!inventory.client.tasksCommit) blockers.push("tasks_revision_unavailable");
    else if (inventory.client.tasksCommit !== release.tasks.commit)
      clientChanges.push({ component: "tasks", current: inventory.client.tasksCommit, target: release.tasks.commit,
        reason: "Tasks must use the exact release commit" });
    if (inventory.client.tasksDirty)
      clientChanges.push({ component: "tasks_worktree", current: inventory.client.tasksCommit, target: release.tasks.commit,
        reason: "Local task changes must be preserved and reviewed before replacing the task checkout" });
    if (Object.values(release.images).some(image => !image.includes("@sha256:")))
      warnings.push("target_has_mutable_tags; alignment compares references and does not certify registry tag contents");
    const byKey = new Map<string, { slot: Slot; consumer: string }[]>();
    for (const workload of inventory.workloads) for (const slot of workload.slots) {
      if (!byKey.has(slot.key)) byKey.set(slot.key, []);
      byKey.get(slot.key)!.push({ slot, consumer: workload.kind + "/" + workload.name + "/" + slot.container });
    }
    if (!inventory.installation.catalog) {
      changes.push({ component: "images_catalog", action: "adopt_catalog", current: [], target: hash(canonical(release.images)),
        consumers: ["Whisk"], reason: "Legacy installation requires a compatible catalog-aware operator before catalog adoption" });
      blockers.push("legacy_catalog_adoption_requires_compatible_operator");
    }
    const keys = new Set([...byKey.keys(), ...Object.keys(release.images)]);
    for (const key of [...keys].sort()) {
      const consumers = byKey.get(key) || [], desired = release.images[key];
      if (!desired) { blockers.push("missing_target_image:" + key); continue; }
      const desiredDigest = desired.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
      if (desiredDigest && consumers.some(({ slot }) => slot.running.some(pod =>
          normalizedImage(pod.reference) === normalizedImage(desired) && pod.digest && pod.digest !== desiredDigest)))
        blockers.push("running_digest_mismatch:" + key);
      const current = [...new Set(consumers.flatMap(({ slot }) => [slot.reference, ...slot.running.map(pod => pod.reference)]))].sort();
      const slotsDiffer = consumers.some(({ slot }) => normalizedImage(slot.reference) !== normalizedImage(desired));
      const podsDiffer = consumers.some(({ slot }) => slot.running.some(pod => normalizedImage(pod.reference) !== normalizedImage(desired)));
      const oldCatalog = inventory.installation.catalog?.[key];
      const catalogDiffers = oldCatalog !== undefined && normalizedImage(oldCatalog) !== normalizedImage(desired);
      const missingCatalogEntry = inventory.installation.catalog !== null && oldCatalog === undefined;
      if (!slotsDiffer && !podsDiffer && !catalogDiffers && !missingCatalogEntry) continue;
      let action: Change["action"] = slotsDiffer ? "rollout" : podsDiffer ? "wait_for_rollout" : "catalog_only";
      let reason = slotsDiffer ? "Managed workload image fields differ" : podsDiffer ? "Running pods have not reached the selected reference" : "Only the persisted image catalog differs";
      if (slotsDiffer && DATABASES.has(key)) {
        const majors = [...new Set(current.map(reference => majorVersion(key, reference)))];
        const targetMajor = majorVersion(key, desired);
        if (targetMajor !== null && majors.every(major => major !== null) && majors.some(major => major !== targetMajor)) {
          action = "migration_required";
          reason = "Database or persistent-service major version changes; an explicit migration is required";
        } else {
          action = "review_required";
          reason = "Persistent-service image change requires a validated compatibility and backup/restore policy";
        }
        blockers.push("persistent_service_change:" + key);
      }
      changes.push({ component: key, action, current: current.length ? current : oldCatalog ? [oldCatalog] : [],
        target: desired, consumers: [...new Set(consumers.map(row => row.consumer))].sort(), reason });
    }
    if (inventory.runtimeCatalog.sha256 !== release.runtimes.sha256) {
      changes.push({ component: "runtimes", action: "review_required", current: [inventory.runtimeCatalog.sha256],
        target: release.runtimes.sha256, consumers: inventory.runtimeCatalog.kinds,
        reason: "Runtime catalog changes require compatibility checks for existing actions and deprecated kinds" });
      blockers.push("runtime_catalog_compatibility_required");
    }
  }
  const uniqueBlockers = [...new Set(blockers)].sort();
  const report = { schemaVersion: 1 as const, mode, readOnly: true as const, automaticApplySupported: false as const,
    status: uniqueBlockers.length ? "blocked" as const : changes.length || clientChanges.length ? "changes_available" as const : "aligned" as const,
    inventory, target, changes, clientChanges, blockers: uniqueBlockers, warnings: [...new Set(warnings)].sort() };
  return { ...report, planSha256: hash(canonical(report)) };
}
interface Options {
  mode: "check" | "plan"; json: boolean; root: string; channel: Channel;
  context?: string; namespace: string; instance: string; manifest?: string; index?: string; to?: string;
}
export function parseOptions(argv: string[], env = process.env): Options {
  let args: any = {};
  if (env.OPS_UPDATE_REQUEST && argv.length === 0) {
    try { args = JSON.parse(env.OPS_UPDATE_REQUEST); } catch { throw new Error("Invalid task-to-planner options"); }
  } else for (const value of argv) {
    if (["--check", "--plan", "--json"].includes(value)) args[value.slice(2)] = true;
    else {
      const match = value.match(/^--(manifest|index|to|channel|context|namespace|instance)=(.+)$/);
      if (!match) throw new Error("Unknown planner option; use --help");
      if (args[match[1]] !== undefined) throw new Error("Duplicate planner option");
      args[match[1]] = match[2];
    }
  }
  const enabled = (value: any) => value === true || value === "true";
  if (enabled(args.check) === enabled(args.plan)) throw new Error("Select exactly one of --check and --plan");
  const channel = args.channel || "stable";
  if (!["stable", "preview"].includes(channel)) throw new Error("Select stable or preview channel");
  if (args.manifest && args.index) throw new Error("--manifest and --index are mutually exclusive");
  const base = env.OPS_PWD || process.cwd();
  const location = (value: string | undefined) => value ? /^[a-z]+:\/\//i.test(value) ? value : resolve(base, value) : undefined;
  return { mode: enabled(args.plan) ? "plan" : "check", json: enabled(args.json),
    root: env.OPS_ROOT || resolve(import.meta.dir, ".."), channel,
    namespace: args.namespace || "openserverless", instance: args.instance || "controller",
    ...(args.context ? { context: args.context } : {}),
    ...(args.manifest ? { manifest: location(args.manifest) } : {}),
    ...(args.index ? { index: location(args.index) } : {}), ...(args.to ? { to: args.to } : {}) };
}
export function human(report: Plan): string {
  const lines = ["Read-only OPS update " + report.mode + ": " + report.status,
    "Cluster: " + report.inventory.cluster.context + " / " + report.inventory.cluster.namespace + " (Kubernetes " + report.inventory.cluster.kubernetesVersion + ")",
    "Target: " + (report.target.release?.id || "unavailable") + " [" + (report.target.release?.channel || "no release") + "]",
    "Managed workloads: " + report.inventory.workloads.length + "; persistent volumes: " + report.inventory.volumes.length,
    "Platform changes: " + report.changes.length + "; client changes: " + report.clientChanges.length];
  if (report.target.reason) lines.push(report.target.reason);
  if (report.mode === "plan") for (const row of report.changes)
    lines.push("  " + row.component + ": " + row.action + " -> " + row.target + " (" + row.consumers.length + " consumers)");
  for (const row of report.clientChanges) lines.push("  " + row.component + ": " + row.reason);
  for (const blocker of report.blockers) lines.push("Blocked: " + blocker);
  for (const warning of report.warnings) lines.push("Note: " + warning);
  lines.push("No changes were applied. Automatic upgrade execution is not implemented.");
  lines.push("Plan SHA-256: " + report.planSha256);
  return lines.join("\n");
}
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help")) {
    console.log("Usage: ops update (--check|--plan) [--manifest=<file>|--index=<file-or-https-url>] [--to=<release-id>] [--channel=stable|preview] [--context=<context>] [--namespace=<namespace>] [--instance=<name>] [--json]");
    return 0;
  }
  const options = parseOptions(argv);
  const target = await selectTarget(options);
  const inventory = collect(options);
  const report = buildPlan(inventory, target, options.mode);
  console.log(options.json ? JSON.stringify(report, null, 2) : human(report));
  return report.status === "blocked" ? 3 : 0;
}
if (import.meta.main) main().then(code => { process.exitCode = code; }).catch(() => {
  // Never forward subprocess stderr or parser excerpts containing cluster data.
  console.error("OPS update planning failed: invalid options, release metadata, or incomplete Kubernetes reads. Use --help and check read permissions.");
  process.exitCode = 1;
});
