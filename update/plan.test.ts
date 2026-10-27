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


import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { buildPlan, majorVersion, normalizedImage, parseOptions } from "./plan";
import { collect, reader, type Client, type Inventory } from "./inventory";
import { hash, canonical, type Release } from "./releases";

const digest = "a".repeat(64);
const client: Client = { cliVersion: "0.9.0", cliSha256: digest, platform: "linux_amd64", tasksCommit: "b".repeat(40), tasksDirty: false };
const options = { root: resolve(import.meta.dir, ".."), namespace: "openserverless", instance: "controller" };
function fixture() {
  const owner = (uid: string) => [{ uid }];
  const workload = (name: string, container: string, image: string, managed = true): any => ({
    kind: "StatefulSet", metadata: { name, uid: name + "-uid", generation: 1, ...(managed ? { ownerReferences: owner("whisk") } : {}) },
    spec: { replicas: 1, template: { spec: { containers: [{ name: container, image, env: [{ name: "SECRET", value: "PRIVATE_CANARY" }] }] } } },
    status: { readyReplicas: 1 }
  });
  const pod = (name: string, parent: string, container: string, image: string): any => ({
    kind: "Pod", metadata: { name, uid: name, ownerReferences: owner(parent + "-uid") },
    spec: { containers: [{ name: container, image }] }, status: { phase: "Running",
      containerStatuses: [{ name: container, ready: true, imageID: "docker-pullable://image@sha256:" + digest }] }
  });
  const images = { controller: "example/controller:1", invoker: "example/invoker:1", operator: "example/operator:1",
    systemapi: "example/systemapi:1", nginx: "nginx:1.24", pgvector: "pgvector/pgvector:pg16" };
  const resources: any[] = [];
  for (const [name, container, key, managed] of [
    ["controller", "controller", "controller", true], ["invoker", "invoker", "invoker", true],
    ["openserverless-operator", "openserverless-operator", "operator", false],
    ["openserverless-system-api", "openserverless-system-api", "systemapi", false],
    ["openserverless-static", "openserverless-static", "nginx", true]
  ] as const) {
    resources.push(workload(name, container, images[key], managed), pod(name + "-0", name, container, images[key]));
  }
  // Private application workloads must not be included in the platform image plan.
  resources.push(workload("private-app", "app", "example/app:9", false),
    { kind: "PersistentVolumeClaim", metadata: { name: "db", uid: "pvc", annotations: { secret: "PRIVATE_CANARY" } },
      spec: { storageClassName: "local-path" }, status: { phase: "Bound", capacity: { storage: "1Gi" } } });
  const runtime = { runtimes: { python: [{ kind: "python:default", image: { name: "runtime:1" } }] } };
  const whisk = { metadata: { uid: "whisk", annotations: { "openserverless.org/release-id": "installed", secret: "PRIVATE_CANARY" } },
    spec: { images, components: { openwhisk: true, invoker: true, static: true },
      openserverless: { slim: true, password: "PRIVATE_CANARY" }, couchdb: { password: "PRIVATE_CANARY" } } };
  const read = (args: string[]) => {
    if (args[0] === "config") return "baseline";
    if (args[0] === "version") return { serverVersion: { gitVersion: "v1.36.4+k3s1" } };
    if (args[1].startsWith("namespace/")) return { metadata: { uid: args[1] } };
    if (args[1].startsWith("whisks.")) return whisk;
    if (args[1].startsWith("statefulsets,")) return { items: resources };
    if (args[1] === "kubegres") return { items: resources.filter(row => row.kind === "Kubegres") };
    if (args[1] === "configmap/openwhisk-runtimes") return { data: { "runtimes.json": JSON.stringify(runtime) } };
    throw Error("Unexpected read");
  };
  return { resources, whisk, runtime, read, workload, pod, owner };
}
function inventory() { return collect(options, fixture().read, structuredClone(client)); }
function target(inv: Inventory, override: Partial<Release> = {}) {
  const release: Release = { schemaVersion: 1, id: "target", version: "0.9.0", distribution: "apache",
    channel: "preview", status: "local", publishedAt: "2026-10-27T00:00:00Z",
    cli: { version: client.cliVersion!, sha256: digest, platform: "linux_amd64" },
    tasks: { repository: "https://github.com/example/tasks", commit: client.tasksCommit! },
    images: { ...inv.installation.catalog! }, runtimes: { sha256: inv.runtimeCatalog.sha256 },
    kubernetes: { minVersion: "1.33.0", maxVersionExclusive: "1.37.0" }, ...override };
  return { release, manifestSha256: hash(canonical(release)), selection: "explicit_manifest" };
}
test("inventory whitelists output, includes PVCs and excludes private action workloads", () => {
  const inv = inventory();
  expect(JSON.stringify(inv)).not.toContain("PRIVATE_CANARY");
  expect(JSON.stringify(inv)).not.toContain("private-app");
  expect(inv.workloads.length).toBe(5);
  expect(inv.volumes[0]).toEqual({ name: "db", uid: "pvc", phase: "Bound", storageClass: "local-path", capacity: "1Gi" });
  expect(inv.workloads.find(w => w.name === "openserverless-operator")?.management).toBe("tasks_by_name");
});
test("deployment owner chains, init containers and inactive CronJobs are inventoried", () => {
  const f = fixture();
  const dep = f.workload("kubegres-controller-manager", "manager", "example/kubegres:1");
  dep.kind = "Deployment";
  const rs = { kind: "ReplicaSet", metadata: { uid: "rs-uid", ownerReferences: f.owner(dep.metadata.uid) } };
  const pod = f.pod("manager-pod", "rs", "manager", "example/kubegres:1");
  f.resources.push(dep, rs, pod, {
    kind: "CronJob", metadata: { uid: "cron", name: "cron-init", ownerReferences: f.owner("whisk") },
    spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "cron-init", image: "example/operator:1" }] } } } } }
  });
  const ctrl = f.resources.find(r => r.metadata.name === "controller");
  ctrl.spec.template.spec.initContainers = [{ name: "check-kafka", image: "busybox:1.36" }];
  const ctrlPod = f.resources.find(r => r.metadata.name === "controller-0");
  ctrlPod.spec.initContainers = ctrl.spec.template.spec.initContainers;
  ctrlPod.status.initContainerStatuses = [{ name: "check-kafka", ready: false, state: { terminated: { exitCode: 0 } } }];
  const inv = collect(options, f.read, client);
  expect(inv.workloads.find(w => w.kind === "Deployment")?.slots[0].running.length).toBe(1);
  expect(inv.workloads.find(w => w.name === "controller")?.slots.find(s => s.key === "busybox")?.running[0].ready).toBe(true);
  expect(inv.workloads.find(w => w.kind === "CronJob")?.slots[0].key).toBe("operator");
});
test("Kubegres follows both child StatefulSets with their actual main-container names", () => {
  const f = fixture();
  f.whisk.spec.components.postgres = true;
  f.resources.push({ kind: "Kubegres", metadata: { name: "openserverless-postgres", uid: "pg", ownerReferences: f.owner("whisk") },
    spec: { image: f.whisk.spec.images.pgvector, replicas: 2 } });
  for (const name of ["openserverless-postgres-1", "openserverless-postgres-2"]) {
    const child = f.workload(name, name, f.whisk.spec.images.pgvector);
    child.metadata.ownerReferences = f.owner("pg");
    f.resources.push(child, f.pod(name + "-0", name, name, f.whisk.spec.images.pgvector));
  }
  const pg = collect(options, f.read, client).workloads.find(w => w.kind === "Kubegres")!;
  expect(pg.slots.length).toBe(2);
  expect(pg.slots.flatMap(s => s.running).length).toBe(2);
  expect(pg.readyReplicas).toBe(2);
});
test("missing or foreign managed workloads block, failed reads never become empty inventories", () => {
  const f = fixture();
  f.resources.find(r => r.metadata.name === "controller").metadata.ownerReferences = f.owner("someone-else");
  const inv = collect(options, f.read, client);
  expect(buildPlan(inv, target(inv), "check").blockers).toContain("incomplete_managed_image_inventory");
  expect(() => collect(options, () => { throw Error("forbidden"); }, client)).toThrow("forbidden");
  expect(() => reader(options)(["apply", "-f", "anything"])).toThrow("forbidden");
});
test("aligned plan is deterministic and records no proposed switches", () => {
  const inv = inventory(), t = target(inv), p = buildPlan(inv, t, "plan");
  expect(p.status).toBe("aligned");
  expect(p.changes).toEqual([]);
  expect(p.clientChanges).toEqual([]);
  expect(p.readOnly).toBe(true);
  expect(p.automaticApplySupported).toBe(false);
  expect(p.planSha256).toBe(buildPlan(inv, t, "plan").planSha256);
});
test("one stateless switch affects exactly one component", () => {
  const inv = inventory(), t = target(inv);
  t.release.images.nginx = "nginx:1.25";
  const p = buildPlan(inv, t, "plan");
  expect(p.status).toBe("changes_available");
  expect(p.changes.map(c => [c.component, c.action])).toEqual([["nginx", "rollout"]]);
  expect(p.changes[0].consumers).toEqual(["StatefulSet/openserverless-static/openserverless-static"]);
});
test("persistent major, opaque and same-major switches remain blocked", () => {
  const inv = inventory();
  // Model one active PostgreSQL slot; collector ownership is tested separately.
  inv.workloads.push({ kind: "Kubegres", name: "openserverless-postgres", uid: "pg", generation: 1,
    management: "whisk", replicas: 1, readyReplicas: 1, slots: [{ key: "pgvector", field: "/spec/image", container: "pg",
      reference: "pgvector/pgvector:pg16", running: [{ pod: "pg-0", reference: "pgvector/pgvector:pg16", digest: null, ready: true }] }] });
  for (const [image, action] of [["pgvector/pgvector:pg18", "migration_required"],
    ["example/postgres:custom", "review_required"], ["pgvector/pgvector:0.8.1-pg16", "review_required"]]) {
    const t = target(inv);
    t.release.images.pgvector = image;
    const p = buildPlan(inv, t, "plan");
    expect(p.status).toBe("blocked");
    expect(p.changes[0].action).toBe(action);
    expect(p.blockers).toContain("persistent_service_change:pgvector");
  }
  expect(majorVersion("pgvector", "pgvector/pgvector:0.8.1-pg18")).toBe(18);
});
test("pod drift is visible separately from the desired template and inactive catalog entries", () => {
  const inv = inventory(), t = target(inv);
  const nginx = inv.workloads.find(w => w.name === "openserverless-static")!.slots[0];
  nginx.running[0].reference = "nginx:1.23";
  expect(buildPlan(inv, t, "plan").changes[0].action).toBe("wait_for_rollout");
  nginx.running[0].reference = nginx.reference;
  t.release.images.pgvector = "pgvector/pgvector:pg18";
  expect(buildPlan(inv, t, "plan").changes[0].action).toBe("catalog_only");
});
test("missing active images, runtime changes, missing catalog and incompatible clients block", () => {
  const inv = inventory();
  const missing = target(inv); delete missing.release.images.controller;
  expect(buildPlan(inv, missing, "plan").blockers).toContain("missing_target_image:controller");
  const rt = target(inv, { runtimes: { sha256: "c".repeat(64) } });
  expect(buildPlan(inv, rt, "plan").blockers).toContain("runtime_catalog_compatibility_required");
  const incompatible = target(inv, { kubernetes: { minVersion: "1.37.0" } });
  expect(buildPlan(inv, incompatible, "check").blockers).toContain("incompatible_kubernetes_version");
  const t = target(inv);
  inv.installation.catalog = null;
  expect(buildPlan(inv, t, "check").blockers).toContain("legacy_catalog_adoption_requires_compatible_operator");
  inv.client.cliSha256 = null;
  expect(buildPlan(inv, t, "check").blockers).toContain("cli_identity_unavailable");
});
test("unready pods, absent running images, unbound volumes and digest mismatch block", () => {
  for (const kind of ["unready", "absent", "volume", "digest"]) {
    const inv = inventory(), t = target(inv);
    const slot = inv.workloads[0].slots[0];
    if (kind === "unready") slot.running[0].ready = false;
    if (kind === "absent") slot.running = [];
    if (kind === "volume") inv.volumes[0].phase = "Pending";
    if (kind === "digest") {
      t.release.images[slot.key] = slot.reference + "@sha256:" + "d".repeat(64);
      slot.reference = slot.running[0].reference = t.release.images[slot.key];
    }
    expect(buildPlan(inv, t, "plan").status).toBe("blocked");
  }
});
test("a new stateless target digest is a proposed rollout, not a corrupt running image", () => {
  const inv = inventory(), t = target(inv);
  t.release.images.nginx += "@sha256:" + "d".repeat(64);
  expect(buildPlan(inv, t, "plan").status).toBe("changes_available");
});
test("client and dirty task changes are reported; no target never means up to date", () => {
  const inv = inventory(), t = target(inv);
  inv.client.cliVersion = "0.8.0"; inv.client.tasksCommit = "c".repeat(40); inv.client.tasksDirty = true;
  expect(buildPlan(inv, t, "check").clientChanges.map(c => c.component)).toEqual(["cli", "tasks", "tasks_worktree"]);
  expect(buildPlan(inv, { release: null, manifestSha256: null, selection: "release_index" }, "check").blockers)
    .toContain("release_target_unavailable");
});
test("image aliases compare equal while registries, digests and tags remain distinct", () => {
  expect(normalizedImage("nginx:1")).toBe(normalizedImage("docker.io/library/nginx:1"));
  expect(normalizedImage("index.docker.io/library/nginx:1")).toBe(normalizedImage("nginx:1"));
  expect(normalizedImage("nginx:1@sha256:" + digest)).toBe(normalizedImage("nginx@sha256:" + digest));
  expect(normalizedImage("registry.example/nginx:1")).not.toBe(normalizedImage("nginx:1"));
});
test("options require one read-only mode and resolve caller paths literally", () => {
  const env = { OPS_PWD: "/tmp/caller" };
  const parsed = parseOptions(["--plan", "--manifest=some file.json", "--channel=preview"], env);
  expect(parsed.manifest).toBe("/tmp/caller/some file.json");
  expect(() => parseOptions(["--check", "--plan"], env)).toThrow();
  expect(() => parseOptions(["--apply"], env)).toThrow();
  expect(() => parseOptions(["--plan", "--manifest=x", "--index=y"], env)).toThrow();
  expect(() => parseOptions(["--plan", "--channel=other"], env)).toThrow();
});
test.skipIf(!process.env.OPS_TEST_BINARY)("real ops task forwards literal paths and only invokes Kubernetes reads", () => {
  const ops = process.env.OPS_TEST_BINARY!;
  const dir = mkdtempSync(join(tmpdir(), "ops-update-cli-"));
  try {
    // Reuse installed tool version markers; never download prerequisites in a test.
    const bin = process.env.OPS_BIN || dirname(process.execPath);
    for (const name of readdirSync(bin)) if (name !== "kubectl")
      symlinkSync(join(bin, name), join(dir, name));
    const f = fixture(), inv = collect(options, f.read, client);
    const responses: any = {};
    for (const args of [["config", "current-context"], ["version", "-ojson"], ["get", "namespace/kube-system"],
      ["get", "namespace/openserverless"], ["get", "whisks.openserverless.org/controller"],
      ["get", "statefulsets,deployments,daemonsets,cronjobs,replicasets,pods,pvc"], ["get", "configmap/openwhisk-runtimes"]])
      responses[args.slice(0, 2).join(" ")] = f.read(args);
    writeFileSync(join(dir, "responses.json"), JSON.stringify(responses));
    writeFileSync(join(dir, "kubectl"), "#!" + process.execPath + "\n" +
      'import {readFileSync,appendFileSync} from "node:fs";\n' +
      'const args=process.argv.slice(2).filter(x=>!x.startsWith("--"));\n' +
      'appendFileSync(process.env.TEST_LOG,JSON.stringify(args)+"\\n");\n' +
      'const r=JSON.parse(readFileSync(process.env.TEST_RESPONSES,"utf8"))[args.slice(0,2).join(" ")];\n' +
      'if(r===undefined) process.exit(2); console.log(typeof r==="string"?r:JSON.stringify(r));\n', { mode: 0o755 });
    const manifestName = "release $(touch NEVER_CREATED) with spaces.json";
    writeFileSync(join(dir, manifestName), JSON.stringify(target(inv).release));
    const result = Bun.spawnSync([ops, "update", "--plan", "--json", "--channel=preview", "--manifest=" + manifestName], {
      cwd: dir, env: { ...process.env, PATH: dir + ":" + process.env.PATH,
        OPS_ROOT: options.root, OPS_PWD: dir, OPS_HOME: dir, OPS_BIN: dir, KUBECONFIG: join(dir, "explicit-config"),
        TEST_LOG: join(dir, "calls.jsonl"), TEST_RESPONSES: join(dir, "responses.json") }, timeout: 30000
    });
    const stdout = result.stdout.toString();
    if (!stdout.trim()) throw new Error("CLI smoke failed (kubectl reached=" + existsSync(join(dir, "calls.jsonl")) + "): " + result.stderr.toString());
    expect(stdout).not.toContain("PRIVATE_CANARY");
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(existsSync(join(dir, "NEVER_CREATED"))).toBe(false);
    const calls = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(calls.every(args => ["get", "version", "config"].includes(args[0]))).toBe(true);
    expect(calls.some(args => args.includes("secrets"))).toBe(false);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});
