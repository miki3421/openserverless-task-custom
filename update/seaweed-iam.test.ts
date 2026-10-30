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

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reconcileRestoredSeaweedIAM, type SeaweedRestoreCheckpoint } from "./seaweed-iam";

const success = JSON.stringify({ schemaVersion: 1, status: "seaweedfs_iam_reconciled" });
function fixture(count = 2) {
  const state: SeaweedRestoreCheckpoint = { schemaVersion: 1, kind: "ops-seaweedfs-restore-checkpoint",
    stage: "backend-and-tenant-definitions-restored", context: "isolated-target",
    target: { namespace: "openserverless", namespaceUid: "target-namespace", clusterUid: "target-cluster",
      whisk: { name: "controller", uid: "target-whisk", spec: { components: { seaweedfs: true },
        seaweedfs: { ingress: { "s3-enabled": false, "console-enabled": false } } } },
      users: Array.from({ length: count }, (_, i) => ({ name: "tenant-" + i, uid: "user-" + i,
        spec: { namespace: "tenant-" + i, "object-storage": { password: "PRIVATE_CANARY",
          data: { enabled: true, bucket: "custom-private-" + i }, route: { enabled: true, bucket: "custom-public-" + i } } } })),
      operator: { name: "operator-0", uid: "operator-uid", container: "operator", imageId: "sha256:" + "a".repeat(64) } } };
  const resource = (d: any, kind: string) => ({ apiVersion: "openserverless.org/v1", kind,
    metadata: { name: d.name, uid: d.uid, namespace: "openserverless" }, spec: structuredClone(d.spec) });
  const live: Record<string, any> = {
    "namespace/kube-system": { metadata: { uid: state.target.clusterUid } },
    "namespace/openserverless": { metadata: { uid: state.target.namespaceUid } },
    "whisks.openserverless.org/controller": resource(state.target.whisk, "Whisk"),
    "whisksusers.openserverless.org": { items: state.target.users.map(u => resource(u, "WhiskUser")) },
    "ingresses.networking.k8s.io": { items: [] }, "cronjobs.batch": { items: [] },
    pods: { items: [{ metadata: { name: "operator-0", uid: "operator-uid", labels: { name: "openserverless-operator" } },
      status: { phase: "Running", containerStatuses: [{ name: "operator", ready: true, imageID: state.target.operator.imageId }] } }] },
  };
  const calls: string[][] = [];
  const read = (args: string[]) => { expect(args[0]).toBe("get"); if (!(args[1] in live)) throw new Error("unexpected_read"); return live[args[1]]; };
  const execute = async (args: string[], input: string) => { calls.push(args); expect(JSON.parse(input)).toEqual(state); return success; };
  return { state, live, read, execute, calls };
}

test("post-restore reconciliation covers every saved tenant and keeps later gates closed", async () => {
  const f = fixture(205);
  const result = await reconcileRestoredSeaweedIAM(f.state, f.read, f.execute);
  expect(result.tenantsVerified).toBe(205);
  expect(result).toMatchObject({ ingressAllowed: false, applicationsAllowed: false, backupComplete: false, uninstallAllowed: false });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].slice(0, 7)).toEqual(["--context=isolated-target", "--namespace=openserverless", "exec", "-i", "pod/operator-0", "-c", "operator"]);
  expect(f.calls[0].join(" ")).not.toContain("PRIVATE_CANARY");
});

test("missing, unexpected or modified tenant definitions prevent any IAM mutation", async () => {
  for (const alter of [(rows: any[]) => rows.pop(), (rows: any[]) => rows.push({ ...rows[0], metadata: { ...rows[0].metadata, name: "unexpected" } }),
    (rows: any[]) => rows[0].spec["object-storage"].route.bucket = "different-public-bucket"]) {
    const f = fixture(); alter(f.live["whisksusers.openserverless.org"].items);
    await expect(reconcileRestoredSeaweedIAM(f.state, f.read, f.execute)).rejects.toThrow("definition_set_mismatch");
    expect(f.calls).toHaveLength(0);
  }
});

test("wrong clusters, namespace reuse, changed Whisk and substituted operator are rejected", async () => {
  for (const alter of [(f: any) => f.live["namespace/kube-system"].metadata.uid = "source-cluster",
    (f: any) => f.live["namespace/openserverless"].metadata.uid = "replacement-namespace",
    (f: any) => f.live["whisks.openserverless.org/controller"].metadata.uid = "replacement-whisk",
    (f: any) => f.live.pods.items[0].metadata.uid = "replacement-pod",
    (f: any) => f.live.pods.items[0].status.containerStatuses[0].imageID = "sha256:" + "b".repeat(64)]) {
    const f = fixture(); alter(f);
    await expect(reconcileRestoredSeaweedIAM(f.state, f.read, f.execute)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  }
});

test("ingress, scheduler and application activity keep the restore gate closed", async () => {
  for (const [key, value] of [["ingresses.networking.k8s.io", { items: [{}] }],
    ["cronjobs.batch", { items: [{ spec: { suspend: false } }] }],
    ["pods", { items: [{ metadata: { name: "synthetic-action", labels: { "user-action-pod": "true" } }, status: { phase: "Running" } }] }]] as const) {
    const f = fixture(); f.live[key] = value;
    await expect(reconcileRestoredSeaweedIAM(f.state, f.read, f.execute)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  }
  const f = fixture(); f.state.target.whisk.spec.components.openwhisk = true;
  f.live["whisks.openserverless.org/controller"].spec.components.openwhisk = true;
  await expect(reconcileRestoredSeaweedIAM(f.state, f.read, f.execute)).rejects.toThrow("gate_not_closed");
});

test("backend failures or malformed receipts never certify post-restore IAM", async () => {
  const f = fixture();
  for (const response of ["", "null", "{}", JSON.stringify({ schemaVersion: 1, status: "seaweedfs_iam_reconciled", applicationsAllowed: true })])
    await expect(reconcileRestoredSeaweedIAM(f.state, f.read, async () => response)).rejects.toThrow("receipt");
  await expect(reconcileRestoredSeaweedIAM(f.state, f.read, async () => { throw new Error("backend_unavailable"); })).rejects.toThrow("backend_unavailable");
});

test("changed definitions after native execution fail acceptance without leaking secrets", async () => {
  const f = fixture();
  try {
    await reconcileRestoredSeaweedIAM(f.state, f.read, async () => { f.live["whisksusers.openserverless.org"].items.pop(); return success; });
    throw new Error("expected_rejection");
  } catch (error) { expect(String(error)).toContain("definition_set_mismatch"); expect(String(error)).not.toContain("PRIVATE_CANARY"); }
});

test("incomplete restore stage, legacy namespace and duplicate expected users are invalid", async () => {
  for (const alter of [(s: any) => s.stage = "backend-only", (s: any) => s.target.namespace = "nuvolaris",
    (s: any) => s.target.users.push(s.target.users[0]), (s: any) => s.context = "", (s: any) => s.target.operator.name = "--all-namespaces"]) {
    const f = fixture(); alter(f.state);
    await expect(reconcileRestoredSeaweedIAM(f.state, f.read, f.execute)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  }
});

test("normal CRI image ID forms remain valid but comparisons bind their exact value", async () => {
  for (const prefix of ["", "containerd://", "docker://", "registry.example/operator@", "docker-pullable://registry.example/operator@"]) {
    const f = fixture(), id = prefix + "sha256:" + "a".repeat(64);
    f.state.target.operator.imageId = id; f.live.pods.items[0].status.containerStatuses[0].imageID = id;
    expect((await reconcileRestoredSeaweedIAM(f.state, f.read, f.execute)).status).toBe("seaweedfs_iam_reconciled");
  }
});

test.skipIf(!process.env.OPS_TEST_BINARY)("real ops CLI discovers the restore gate and forwards the protected path literally", () => {
  const root = mkdtempSync(join(tmpdir(), "ops-restore-iam-cli-"));
  try {
    const bin = process.env.OPS_BIN || dirname(process.execPath);
    for (const name of readdirSync(bin)) symlinkSync(join(bin, name), join(root, name));
    const result = Bun.spawnSync([process.env.OPS_TEST_BINARY!, "update", "restore-reconcile-iam",
      "--restore-state=missing $(touch NEVER_CREATED).json", "--json"], { cwd: root, timeout: 30000,
      env: { ...process.env, OPS_ROOT: join(import.meta.dir, ".."), OPS_PWD: root, OPS_HOME: root,
        OPS_BIN: root, PATH: root + ":" + process.env.PATH } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Post-restore IAM reconciliation failed:");
    expect(existsSync(join(root, "NEVER_CREATED"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
