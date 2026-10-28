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
import { discoverSource } from "./source";
import { scanDatabase, inventoryMigration, entityRecord, couchReader } from "./migration";
import { draftExport, verifyExport } from "./bundle";
import { hash, canonical } from "./releases";

const CANARY = "PRIVATE_CREDENTIAL_CODE_OR_PARAMETER_CANARY";
function fixture(brand = "nuvolaris", count = 3) {
  const namespace = brand;
  const api = brand + ".org";
  const whisk: any = { apiVersion: api + "/v1", kind: "Whisk",
    metadata: { name: "controller", namespace, uid: "whisk", generation: 7 },
    spec: { [brand]: { password: CANARY }, openwhisk: { namespaces: { [brand]: CANARY } },
      components: { couchdb: true, postgres: true, mongodb: true, redis: true, seaweedfs: true, milvus: true },
      couchdb: { host: "couchdb", admin: { user: "admin", password: CANARY } } } };
  const users: any[] = [], subjects: any[] = [{ _id: "_design/auth", _rev: "1-a" },
    { _id: brand, _rev: "1-b", namespaces: [{ name: brand, uuid: "system", key: CANARY }] }];
  const entities: any[] = [{ _id: "_design/whisks", _rev: "1-c" }];
  for (let n = 0; n < count; n++) {
    const name = "tenant" + String(n).padStart(5, "0"), auth = "uuid" + n + ":" + CANARY;
    users.push({ apiVersion: api + "/v1", kind: "WhiskUser",
      metadata: { name, namespace, uid: "user-" + n, generation: 1 },
      spec: { namespace: name, auth, password: CANARY, email: CANARY,
        postgres: { enabled: true, password: CANARY }, "object-storage": { route: { enabled: true } } } });
    subjects.push({ _id: name, _rev: "1-subject", namespaces: [{ name, uuid: "uuid" + n, key: CANARY }] });
    const add = (scope: string, name: string, fields: any) => entities.push({
      _id: scope + "/" + name, _rev: "1-entity", namespace: scope, name, version: "0.0.1",
      annotations: [{ key: "private", value: CANARY }], ...fields });
    add(name, "orders", { binding: {}, parameters: [{ key: "secret", value: CANARY }] });
    add(name + "/orders", "run", { exec: { kind: "python:3.12", code: CANARY }, parameters: [{ value: CANARY }] });
    add(name, "another-app", { exec: { kind: "nodejs:22", code: CANARY } });
    add(name, "event", { parameters: [{ value: CANARY }], limits: {} });
    add(name, "route", { trigger: { path: name, name: "event" }, action: { path: name, name: "another-app" } });
  }
  const controller = { metadata: { ownerReferences: [{ uid: "whisk" }] }, spec: { template: { spec: { containers: [{
    name: "controller", env: ["WhiskAuth", "WhiskEntity", "WhiskActivation"].map((type, i) => ({
      name: "CONFIG_whisk_couchdb_databases_" + type, value: brand + "_" + ["subjects", "whisks", "activations"][i] })) }] } } } };
  const calls: string[][] = [], httpCalls: string[] = [];
  const read = (args: string[]) => {
    calls.push(args);
    const resource = args[1];
    if (args[0] === "version") return { serverVersion: { gitVersion: "v1.27.7+k3s2" } };
    if (args[0] === "config") return "source-context";
    if (resource === "customresourcedefinitions.apiextensions.k8s.io")
      return { items: [{ metadata: { name: "whisks." + api }, spec: { group: api, versions: [{ name: "v1", served: true }] } }] };
    if (resource === "namespaces") return { items: [{ metadata: { name: namespace } }] };
    if (resource === "whisks." + api) return { items: [whisk] };
    if (resource === "whisks." + api + "/controller") return whisk;
    if (resource === "whisksusers." + api) return { items: users };
    if (resource === "statefulset/controller") return controller;
    if (resource === "service/couchdb") return { metadata: { ownerReferences: [{ uid: "whisk" }] },
      spec: { clusterIP: "10.43.0.2", ports: [{ port: 5984 }] } };
    if (resource === "pvc,ingress.networking.k8s.io") return { items: [
      { kind: "PersistentVolumeClaim", metadata: { name: brand + "-data", uid: "volume", annotations: { private: CANARY } },
        spec: { storageClassName: "local-path" }, status: { phase: "Bound" } },
      { kind: "Ingress", metadata: { name: "site" }, spec: { tls: [{ secretName: "site-cert" }] } }] };
    throw new Error("unexpected_fixture_read");
  };
  let sequence = 1;
  const get = async (path: string) => {
    httpCalls.push(path);
    if (path === "/_all_dbs") return [brand + "_subjects", brand + "_whisks", brand + "_activations", "_users"];
    const url = new URL(path, "http://fixture.invalid");
    const data = url.pathname.startsWith("/" + brand + "_subjects") ? subjects : entities;
    const sorted = [...data].sort((a, b) => Buffer.compare(Buffer.from(a._id), Buffer.from(b._id)));
    if (!url.pathname.endsWith("/_all_docs")) return { update_seq: sequence, doc_count: data.length };
    const start = url.searchParams.get("startkey");
    const offset = start ? sorted.findIndex(d => d._id === JSON.parse(start)) + Number(url.searchParams.get("skip")) : 0;
    return { total_rows: data.length, rows: sorted.slice(offset, offset + Number(url.searchParams.get("limit"))).map(doc => ({
      id: doc._id, key: doc._id, value: { rev: doc._rev }, doc })) };
  };
  const client = { cliVersion: "0.1.0", cliSha256: "a".repeat(64), platform: "linux_amd64", tasksCommit: "b".repeat(40), tasksDirty: false };
  return { brand, api, namespace, whisk, users, subjects, entities, controller, calls, httpCalls, read, get, client,
    drift: () => { sequence++; },
    run: () => inventoryMigration({ instance: "controller" }, read, () => get, client) };
}
test("legacy and current API groups are discovered without editing source identity", async () => {
  for (const brand of ["nuvolaris", "openserverless"]) {
    const f = fixture(brand), report = await f.run();
    expect(report.source.apiGroup).toBe(brand + ".org");
    expect(report.source.namespace).toBe(brand);
    expect(report.volumes[0].name).toBe(brand + "-data");
    expect(report.namespaces.length).toBe(4);
    expect(report.uninstallAllowed).toBe(false);
    expect(report.backupComplete).toBe(false);
    expect(report.source.configSha256).toHaveLength(64);
    expect(report.tlsReferences).toEqual([{ ingress: "site", secret: "site-cert" }]);
    expect(JSON.stringify(report)).not.toContain(CANARY);
    expect(JSON.stringify(report)).not.toContain("password");
    const { inventorySha256, ...content } = report;
    expect(hash(canonical(content))).toBe(inventorySha256);
  }
});
test("unknown application counts and multiple apps/packages in a tenant cross page boundaries", async () => {
  const f = fixture("nuvolaris", 523), report = await f.run();
  expect(report.namespaces.filter(n => n.management === "whiskuser").length).toBe(523);
  expect(report.namespaces.reduce((n, row) => n + row.entities.length, 0)).toBe(523 * 5);
  expect(new Set(report.namespaces.flatMap(n => n.entities.map(e => e.type)))).toEqual(new Set(["action", "package", "trigger", "rule"]));
  expect(f.httpCalls.filter(p => p.includes("_subjects/_all_docs")).length).toBe(3);
  expect(f.httpCalls.filter(p => p.includes("_whisks/_all_docs")).length).toBe(14);
});
test("subjects-only and entities-only namespaces cannot silently disappear", async () => {
  const f = fixture();
  f.subjects.push({ _id: "manual", _rev: "1", namespaces: [{ name: "manual", uuid: "manual", key: CANARY }] });
  f.entities.push({ _id: "orphan/run", _rev: "1", namespace: "orphan", name: "run", exec: { kind: "python:3.12" } });
  const report = await f.run();
  expect(report.namespaces.find(n => n.name === "manual")?.management).toBe("subjects_only");
  expect(report.namespaces.find(n => n.name === "orphan")?.management).toBe("entities_only");
  expect(report.blockers).toContain("unmanaged_namespaces_require_restore_mapping");
  expect(report.blockers).toContain("namespace_without_subject_credentials");
});
test("all namespace keys are counted; tenant credential mismatch is a blocker, secrets are redacted", async () => {
  const f = fixture();
  f.subjects.push({ _id: "second-subject", _rev: "1", namespaces: [{ name: "tenant00000", uuid: "another", key: CANARY }] });
  f.users[1].spec.auth = "mismatched:" + CANARY;
  const report = await f.run();
  expect(report.namespaces.find(n => n.name === "tenant00000")?.credentialCount).toBe(2);
  expect(report.blockers).toContain("tenant_auth_mismatch");
  expect(JSON.stringify(report)).not.toContain(CANARY);
});
test("ambiguous installations and duplicate tenant identities are rejected", async () => {
  const f = fixture();
  const duplicate = (args: string[]) => args[1] === "whisks." + f.api ? { items: [f.whisk, f.whisk] } : f.read(args);
  expect(() => discoverSource({ instance: "controller" }, duplicate)).toThrow("ambiguous_whisk_source");
  f.users.push(structuredClone(f.users[0]));
  await expect(f.run()).rejects.toThrow("duplicate_or_system_tenant_identity");
});
test("source drift and failed reads never produce a complete inventory", async () => {
  const f = fixture();
  let scanned = false;
  const get = async (path: string) => {
    if (path.includes("_whisks/_all_docs")) { f.drift(); scanned = true; }
    return f.get(path);
  };
  await expect(inventoryMigration({ instance: "controller" }, f.read, () => get, f.client)).rejects.toThrow("source_database_changed");
  expect(scanned).toBe(true);
  const broken = async (_: string) => { throw new Error("synthetic_failure"); };
  await expect(inventoryMigration({ instance: "controller" }, f.read, () => broken, f.client)).rejects.toThrow();
});
test("unsupported entity schemas, duplicate rows and truncated pagination fail", async () => {
  const f = fixture();
  f.entities.push({ _id: "unknown/resource", _rev: "1", namespace: "unknown", name: "resource", opaque: CANARY });
  await expect(f.run()).rejects.toThrow("unknown_openwhisk_entity_type");
  const duplicate = async (path: string) => path.includes("_all_docs") ?
    { total_rows: 2, rows: [0, 0].map(() => ({ id: "same", key: "same", doc: { _id: "same" } })) } : { update_seq: 1, doc_count: 2 };
  await expect(scanDatabase(duplicate, "source", () => {})).rejects.toThrow("repeated");
  const truncated = async (path: string) => path.includes("_all_docs") ?
    { total_rows: 2, rows: [{ id: "one", key: "one", doc: { _id: "one" } }] } : { update_seq: 1, doc_count: 2 };
  await expect(scanDatabase(truncated, "source", () => {})).rejects.toThrow("incomplete_database_scan");
});
test("empty tenants are inventoried and custom runtimes and attachments remain explicit", async () => {
  const f = fixture();
  f.entities.splice(1);
  let report = await f.run();
  expect(report.namespaces.filter(n => n.management === "whiskuser").length).toBe(3);
  expect(report.namespaces.every(n => n.entities.length === 0)).toBe(true);
  f.entities.push({ _id: "tenant00000/image", _rev: "1", namespace: "tenant00000", name: "image",
    exec: { kind: "blackbox", image: "private.example/image:mutable" }, _attachments: { executable: { stub: true } } });
  report = await f.run();
  expect(report.blockers).toContain("custom_runtime_images_require_export");
  expect(report.blockers).toContain("entity_attachments_require_export");
});
test("new components, extra databases and system entities require explicit migration handling", async () => {
  const f = fixture();
  f.whisk.spec.components["custom-backend"] = true;
  f.entities.push({ _id: "nuvolaris/custom", _rev: "1", namespace: "nuvolaris", name: "custom", exec: { kind: "nodejs:22" } });
  const get = async (path: string) => path === "/_all_dbs" ? [...await f.get(path), "custom_data"] : f.get(path);
  const report = await inventoryMigration({ instance: "controller" }, f.read, () => get, f.client);
  expect(report.blockers).toContain("unmapped_enabled_components");
  expect(report.blockers).toContain("additional_couchdb_databases_require_export_mapping");
  expect(report.blockers).toContain("system_namespace_resource_policy_required");
});
test("an explicit context is reported without switching the current context", async () => {
  const f = fixture();
  const report = await inventoryMigration({ instance: "controller", context: "explicit-source" }, f.read, () => f.get, f.client);
  expect(report.source.context).toBe("explicit-source");
  expect(f.calls.some(a => a[0] === "config")).toBe(false);
  expect(f.calls.every(a => a[0] === "get" || a[0] === "version")).toBe(true);
});
test("internal CouchDB reads require owned resources and never follow redirects or send credentials in URLs", async () => {
  const f = fixture(), source = discoverSource({ instance: "controller" }, f.read);
  const service = f.read(["get", "service/couchdb"]);
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    requests++;
    expect(String(input)).toBe("http://10.43.0.2:5984/nuvolaris_subjects");
    expect(String(input)).not.toContain(CANARY);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.headers.Authorization).toBe("Basic " + Buffer.from("admin:" + CANARY).toString("base64"));
    return new Response("redirect body " + CANARY, { status: 302, headers: { Location: "http://external.invalid/" } });
  }) as any;
  try {
    await expect(couchReader(source, service, f.controller)("/nuvolaris_subjects")).rejects.toThrow("couchdb_read_failed");
    expect(() => couchReader(source, { ...service, metadata: { ownerReferences: [] } }, f.controller)).toThrow("ownership");
    expect(requests).toBe(1);
  } finally { globalThis.fetch = original; }
});
test("an exact multiple of 200 rows requests the terminal empty page", async () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ _id: String(i).padStart(5, "0") }));
  let pages = 0, seen = 0;
  const get = async (path: string) => {
    const url = new URL(path, "http://fixture.invalid");
    if (!path.includes("_all_docs")) return { doc_count: 400, update_seq: 1 };
    pages++;
    const start = url.searchParams.get("startkey");
    const offset = start ? Number(JSON.parse(start)) + 1 : 0;
    return { total_rows: 400, rows: rows.slice(offset, offset + 200).map(doc => ({ id: doc._id, key: doc._id, doc })) };
  };
  expect(await scanDatabase(get, "source", () => { seen++; })).toBe(400);
  expect(seen).toBe(400);
  expect(pages).toBe(3);
});
test("entity summaries exclude code, parameters and annotations values", () => {
  const record = entityRecord({ _id: "tenant/pkg/run", _rev: "2-abc", namespace: "tenant/pkg", name: "run",
    exec: { kind: "sequence", components: [CANARY] }, parameters: [{ value: CANARY }],
    annotations: [{ key: "cron", value: CANARY }], version: "0.1.0" });
  expect(record.scheduled).toBe(true);
  expect(record.runtime).toBe("sequence");
  expect(JSON.stringify(record)).not.toContain(CANARY);
});
test("bundle drafts cover every tenant and service and never permit removal", async () => {
  const report = await fixture().run();
  const bundle = draftExport(report, "k3s-legacy-rebuild", "0.9.0", "c".repeat(64));
  expect(bundle.namespaces.length).toBe(report.namespaces.length);
  expect(bundle.artifacts.some(a => a.id === "seaweedfs-data")).toBe(true);
  await expect(verifyExport(bundle, report, { open: async () => { throw new Error("unused"); } })).rejects.toThrow("invalid_export_manifest");
});
test("export integrity checks stream data and reject missing tenants, corruption and unsafe files", async () => {
  const report = await fixture().run();
  const bundle = draftExport(report, "kind-to-k3s", "0.9.0", "c".repeat(64));
  const bytes = Buffer.from("synthetic export payload");
  bundle.state = "exported";
  bundle.sourceQuiescence = { writesStopped: true, schedulersStopped: true, invocationsDrained: true };
  for (const artifact of bundle.artifacts) {
    artifact.status = "exported";
    artifact.files = [{ path: artifact.id + "/data.bin", bytes: bytes.length, sha256: hash(bytes) }];
  }
  const open = async () => ({ privateRegularFile: true, stream: (async function* () { yield bytes.subarray(0, 4); yield bytes.subarray(4); })() });
  expect(await verifyExport(bundle, report, { open })).toEqual({ exportIntegrityVerified: true, restoreVerified: false, uninstallAllowed: false });
  const missing = structuredClone(bundle); missing.namespaces.pop();
  await expect(verifyExport(missing, report, { open })).rejects.toThrow("coverage");
  const bad = structuredClone(bundle); bad.artifacts[0].files[0].sha256 = "0".repeat(64);
  await expect(verifyExport(bad, report, { open })).rejects.toThrow("checksum");
  const traversal = structuredClone(bundle); traversal.artifacts[0].files[0].path = "../outside";
  await expect(verifyExport(traversal, report, { open })).rejects.toThrow("invalid_export_file");
  await expect(verifyExport(bundle, report, { open: async () => ({ ...(await open()), privateRegularFile: false }) })).rejects.toThrow("private_regular_file");
});
