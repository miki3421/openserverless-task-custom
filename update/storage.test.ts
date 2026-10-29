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
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { filerTree, validateMilvusMetadata, verifyMilvusTool, collectSeaweed, collectMilvus, runPrivate,
  type JSONClient, type PrivateRunner } from "./storage";
import { nativeJobs } from "./native";

const CANARY = "PRIVATE_STORAGE_PASSWORD_CANARY";
function output() { const root = mkdtempSync(join(tmpdir(), "ops-storage-")); chmodSync(root, 0o700); return root; }
function fixture() {
  const namespace = "nuvolaris", uid = "whisk-uid";
  const milvus: any = { metadata: { name: "vectors-pod", namespace, uid: "milvus-pod", labels: { app: "vectors" } },
    spec: { volumes: [{ configMap: { name: "nuvolaris-milvus" } }], containers: [{ name: "standalone", image: "milvusdb/milvus:v2.5.2", env: [] }] },
    status: { phase: "Running", podIP: "10.0.0.2", containerStatuses: [{ name: "standalone", ready: true }] } };
  const seaweed: any = { metadata: { name: "seaweed-pod", namespace, uid: "seaweed-pod", labels: { app: "objects" } },
    spec: { containers: [{ name: "seaweedfs", image: "example.invalid/weed:3.97", args: ["server", "-filer", "-filer.port=9090", "-master.port=9333"] }] },
    status: { phase: "Running", podIP: "10.0.0.3", containerStatuses: [{ name: "seaweedfs", ready: true }] } };
  const cm: any = { metadata: { namespace, name: "nuvolaris-milvus", ownerReferences: [{ uid }] }, data: {
    "default.yaml": JSON.stringify({ minio: { address: "seaweedfs", port: 9000, bucketName: "vectors", rootPath: "files", accessKeyID: CANARY, secretAccessKey: CANARY } }),
    "user.yaml": JSON.stringify({ common: { security: { defaultRootPassword: CANARY } } }) } };
  const services: any = {};
  for (const [name, app, ports, ip] of [["seaweedfs", "objects", [9000], "10.43.0.1"], ["nuvolaris-milvus", "vectors", [19530, 9091], "10.43.0.2"]] as const)
    services[name] = { metadata: { name, namespace, ownerReferences: [{ uid }] }, spec: { type: "ClusterIP", clusterIP: ip, selector: { app }, ports: ports.map(port => ({ port })) } };
  const plan: any = { source: { namespace, uid, brand: "nuvolaris" }, architectures: ["amd64"], collectionBlockers: [], bindings: [
    { artifactId: "milvus-data", targets: [{ pod: milvus.metadata.name, podUid: milvus.metadata.uid, container: "standalone", image: milvus.spec.containers[0].image }] },
    { artifactId: "seaweedfs-data", targets: [{ pod: seaweed.metadata.name, podUid: seaweed.metadata.uid, container: "seaweedfs", image: seaweed.spec.containers[0].image }] } ] };
  const read = (args: string[]) => {
    if (args[0] !== "get") throw new Error("unexpected_mutation");
    if (args[1] === "pod/vectors-pod") return milvus;
    if (args[1] === "pod/seaweed-pod") return seaweed;
    if (args[1] === "pods") return { items: [milvus, seaweed] };
    if (args[1].startsWith("service/")) return services[args[1].slice(8)];
    if (args[1] === "configmap/nuvolaris-milvus") return cm;
    throw new Error("unexpected_fixture_read");
  };
  return { plan, read, milvus, seaweed, cm, services };
}
test("filer pagination covers all entries and directories and refuses stalled or repeated cursors", async () => {
  const names = Array.from({ length: 1501 }, (_, i) => "file" + String(i).padStart(5, "0"));
  const calls: string[] = [];
  const get: JSONClient = async (_, path) => {
    calls.push(path); const url = new URL(path, "http://fixture.invalid"), last = url.searchParams.get("lastFileName");
    const offset = last ? names.indexOf(last) + 1 : 0;
    const page = names.slice(offset, offset + 1000);
    return { Entries: page.map(n => ({ FullPath: "/" + n, Mode: 0, FileSize: 1 })), ShouldDisplayLoadMore: offset === 0, LastFileName: page.at(-1) };
  };
  expect(Object.keys(await filerTree("http://fixture.invalid", get))).toHaveLength(1501); expect(calls).toHaveLength(2);
  const stalled: JSONClient = async () => ({ Entries: [], ShouldDisplayLoadMore: true, LastFileName: "same" });
  await expect(filerTree("http://fixture.invalid", stalled)).rejects.toThrow("pagination_stalled");
  const invalid: JSONClient = async () => ({ Entries: [{ FullPath: "/../outside", Mode: 0 }] });
  await expect(filerTree("http://fixture.invalid", invalid)).rejects.toThrow("entry_path");
  const tree: JSONClient = async (_, path) => path.startsWith("/dir/") ?
    { Entries: [{ FullPath: "/dir/file", Mode: 0 }] } : { Entries: [{ FullPath: "/dir", Mode: 0x80000000 }] };
  expect(Object.keys(await filerTree("http://fixture.invalid", tree))).toEqual(["/dir", "/dir/file"]);
});
function metadata(name = "backup") { return { name, milvus_version: "v2.5.2", rbac_meta: { users: [{ user: "synthetic", password: CANARY }] },
  database_backups: [{ db_name: "default" }, { db_name: "empty" }], collection_backups: [{ db_name: "default", collection_name: "synthetic" }] }; }
test("Milvus metadata must include all databases including empty ones, collections and RBAC", () => {
  const catalog = { default: ["synthetic"], empty: [] };
  expect(() => validateMilvusMetadata(metadata(), catalog, "backup")).not.toThrow();
  const m = metadata(); m.database_backups.pop();
  expect(() => validateMilvusMetadata(m, catalog, "backup")).toThrow("database_coverage");
  const n = metadata(); n.collection_backups = [];
  expect(() => validateMilvusMetadata(n, catalog, "backup")).toThrow("collection_coverage");
  const r = metadata(); r.rbac_meta.users = [];
  expect(() => validateMilvusMetadata(r, catalog, "backup")).toThrow("metadata_or_rbac");
});
test("SeaweedFS and Milvus cannot fall back to a live database tar job", () => {
  const f = fixture();
  for (const id of ["seaweedfs-data", "milvus-data"]) expect(() => nativeJobs(f.plan, id)).toThrow("not_supported");
});
test("SeaweedFS uses the exact captured binary, native volume files and stable filer references", async () => {
  const f = fixture(), root = output(), labels: string[] = [];
  const get: JSONClient = async (origin) => origin.endsWith(":8080") ? { Volumes: [{ Id: 1, Collection: "synthetic" }] } :
    { Entries: [{ FullPath: "/synthetic", Mode: 0, FileSize: 8, Chunks: [{ file_id: "synthetic" }] }] };
  const run: PrivateRunner = async (_, args, out, label) => {
    labels.push(label);
    if (label === "weed-metadata") writeFileSync(join(out, "filer.meta"), "synthetic metadata");
    if (label === "weed-volume-1") { writeFileSync(join(out, "volumes/synthetic_1.dat"), "synthetic data"); writeFileSync(join(out, "volumes/synthetic_1.idx"), ""); }
  };
  try {
    const files = await collectSeaweed(f.plan, root, f.read, async (_, fd) => {
      const binary = Buffer.alloc(64); binary.write("\x7fELF"); binary[4] = 2; binary[5] = 1; binary.writeUInt16LE(62, 18); writeFileSync(fd, binary); return 0;
    }, get, run);
    expect(labels).toEqual(["weed-version", "weed-metadata", "weed-volume-1"]);
    expect(files.find(p => p.path.endsWith(".idx"))?.bytes).toBe(0);
    expect(files.some(p => p.path === "filer-manifest.json")).toBe(true);
    expect(JSON.stringify(files)).not.toContain(CANARY);
    expect(statSync(join(root, "weed")).mode & 0o777).toBe(0o700);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("native command errors are rejected even when a tool returns zero", async () => {
  const root = output();
  try {
    await expect(runPrivate("/bin/sh", ["-c", "printf 'Error synchronizing volume\\n'"], root, "native"))
      .rejects.toThrow("command_reported_error");
    expect(statSync(join(root, "native.stdout")).mode & 0o777).toBe(0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Milvus tool must match the pinned executable hash and private directory", async () => {
  const root = output();
  try {
    writeFileSync(join(root, "milvus-backup"), "unqualified tool", { mode: 0o700 });
    await expect(verifyMilvusTool(root)).rejects.toThrow("checksum_mismatch");
    chmodSync(root, 0o755); await expect(verifyMilvusTool(root)).rejects.toThrow("not_private");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Milvus backup uses local storage, all collections and RBAC while keeping credentials in a private config", async () => {
  const f = fixture(), root = output(); let calls = 0;
  const get: JSONClient = async (_, path, options) => {
    expect(options?.token).toBe("root:" + CANARY);
    if (path.endsWith("databases/list")) return { code: 0, data: ["default", "empty"] };
    return { code: 0, data: (options?.body as any).dbName === "default" ? ["synthetic"] : [] };
  };
  const run: PrivateRunner = async (_, args, out) => {
    calls++; expect(args).toContain("--rbac"); expect(args).toContain("--format=binlog"); expect(args.some(a => a.startsWith("--filter"))).toBe(false);
    const config = JSON.parse(readFileSync(join(out, "milvus-backup.yaml"), "utf8"));
    expect(config.backup.storage.provider).toBe("local"); expect(config.milvus.password).toBe(CANARY);
    const name = args.find(a => a.startsWith("--name="))!.slice(7), dir = join(out, "data", name, "meta");
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "full_meta.json"), JSON.stringify(metadata(name)));
    writeFileSync(join(out, "data", name, "synthetic.binlog"), "synthetic vector data");
  };
  try {
    const files = await collectMilvus(f.plan, root, f.read, "/fake/tools", get, run, async () => "/fake/tool");
    expect(calls).toBe(1); expect(files.some(f => f.path.endsWith("full_meta.json"))).toBe(true);
    expect(files.some(f => f.path.endsWith(".binlog"))).toBe(true);
    expect(files.every(f => (statSync(join(root, f.path)).mode & 0o777) === 0o600)).toBe(true);
    expect(JSON.stringify(files)).not.toContain(CANARY);
    const report = JSON.parse(readFileSync(join(root, "milvus-catalog.json"), "utf8"));
    expect(report.rbacIncluded).toBe(true); expect(report.restoredCollectionsVerified).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("an object storage selector or environment override cannot silently change the Milvus backup source", async () => {
  const f = fixture(), root = output();
  try {
    f.services.seaweedfs.spec.selector = { app: "different" };
    await expect(collectMilvus(f.plan, root, f.read, "/fake/tools", undefined, undefined, async () => "/fake/tool"))
      .rejects.toThrow("service_target_mismatch");
    const g = fixture(); g.milvus.spec.containers[0].env.push({ name: "MINIO_ADDRESS", value: "external.invalid" });
    await expect(collectMilvus(g.plan, root, g.read, "/fake/tools", undefined, undefined, async () => "/fake/tool"))
      .rejects.toThrow("environment_override");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
