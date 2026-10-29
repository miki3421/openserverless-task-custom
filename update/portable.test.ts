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
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectPlatform, collectOpenWhisk, type CouchExportClient } from "./portable";
import { hash } from "./releases";

const CANARY = "PRIVATE_CODE_KEY_PASSWORD_AND_CERTIFICATE_CANARY";
function output() {
  const root = mkdtempSync(join(tmpdir(), "ops-portable-")); chmodSync(root, 0o700); return root;
}
function fixture() {
  const s = { namespace: "nuvolaris", instance: "controller", apiGroup: "nuvolaris.org", uid: "whisk", namespaceUid: "namespace" };
  const rows: any[] = [
    { apiVersion: "nuvolaris.org/v1", kind: "Whisk", metadata: { namespace: s.namespace, name: "controller", uid: s.uid }, spec: { password: CANARY } },
    { apiVersion: "nuvolaris.org/v1", kind: "WhiskUser", metadata: { namespace: s.namespace, name: "any-tenant", uid: "user" }, spec: { auth: CANARY } },
    { apiVersion: "v1", kind: "Secret", metadata: { namespace: s.namespace, name: "site-cert", uid: "tls" }, type: "kubernetes.io/tls", data: { "tls.crt": CANARY, "tls.key": CANARY } },
  ];
  const plan: any = { source: s }, inventory: any = { inventorySha256: "a".repeat(64), components: ["postgres"],
    tlsReferences: [{ secret: "site-cert" }], namespaces: [], databaseCounts: { subjects: 0, entities: 0 } };
  const calls: string[][] = [];
  const read = (args: string[]) => {
    calls.push(args);
    if (args[0] !== "get") throw new Error("unexpected mutation");
    if (args[1] === "namespace/nuvolaris") return { apiVersion: "v1", kind: "Namespace", metadata: { name: "nuvolaris", uid: "namespace" } };
    if (args[1].startsWith("customresourcedefinitions.")) return { apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition", metadata: { uid: args[1] }, spec: { group: "nuvolaris.org" } };
    return { items: rows };
  };
  return { s, rows, plan, inventory, read, calls };
}
test("platform export privately preserves all identity credentials and referenced TLS material", async () => {
  const f = fixture(), root = output();
  try {
    const files = await collectPlatform(f.inventory, f.plan, root, f.read);
    expect(files).toHaveLength(1); expect(files[0].sha256).toBe(hash(readFileSync(join(root, files[0].path))));
    const artifact = JSON.parse(readFileSync(join(root, files[0].path), "utf8"));
    expect(artifact.resources.find((r: any) => r.kind === "WhiskUser").spec.auth).toBe(CANARY);
    expect(artifact.resources.find((r: any) => r.kind === "Secret").data["tls.key"]).toBe(CANARY);
    expect(statSync(join(root, files[0].path)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(files)).not.toContain(CANARY); expect(f.calls.every(c => c[0] === "get")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("missing certificates, a recreated namespace and credential drift cannot produce a platform success artifact", async () => {
  const f = fixture(), root = output();
  try {
    delete f.rows.find(r => r.kind === "Secret").data["tls.key"];
    await expect(collectPlatform(f.inventory, f.plan, root, f.read)).rejects.toThrow("missing_platform_tls_material");
    const g = fixture(); g.plan.source.namespaceUid = "recreated";
    await expect(collectPlatform(g.inventory, g.plan, root, g.read)).rejects.toThrow("platform_namespace_changed");
    const h = fixture(); let snapshots = 0;
    const read = (args: string[]) => {
      if (args[1].includes(",secrets,")) {
        snapshots++; if (snapshots === 2) h.rows[1].spec.auth = "changed-private-key";
      }
      return h.read(args);
    };
    await expect(collectPlatform(h.inventory, h.plan, root, read)).rejects.toThrow("changed_during_export");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
function couchFixture(count = 523) {
  const f = fixture(), root = output();
  const subjects = Array.from({ length: count }, (_, n) => ({ _id: "tenant" + String(n).padStart(6, "0"), _rev: "1-subject", namespaces: [{ name: "tenant" + n, key: CANARY }] }));
  const entities = Array.from({ length: count }, (_, n) => ({ _id: subjects[n]._id + "/app/run", _rev: "1-entity",
    exec: { kind: "python:3.12", code: CANARY }, parameters: [{ key: "private", value: CANARY }] }));
  const payload = Buffer.from("synthetic binary action executable");
  (entities[0] as any)._attachments = { "../unsafe-looking-name.zip": { stub: true, length: payload.length } };
  let sequence = 1; const calls: string[] = [];
  const get = async (path: string) => {
    calls.push(path);
    if (path === "/_all_dbs") return ["legacy_subjects", "legacy_entities", "legacy_activations", "extra_data"];
    if (path.endsWith("/_security")) return { admins: { names: [CANARY] } };
    const u = new URL(path, "http://fixture.invalid"), docs = u.pathname.startsWith("/legacy_subjects") ? subjects : entities;
    if (!u.pathname.endsWith("/_all_docs")) return { doc_count: docs.length, update_seq: sequence };
    const start = u.searchParams.get("startkey");
    const offset = start ? docs.findIndex(d => d._id === JSON.parse(start)) + 1 : 0;
    return { total_rows: docs.length, rows: docs.slice(offset, offset + Number(u.searchParams.get("limit"))).map(doc => ({ id: doc._id, key: doc._id, value: { rev: doc._rev }, doc })) };
  };
  const attachmentCalls: string[] = [];
  const client: CouchExportClient = { get, attachment: async path => { attachmentCalls.push(path); return new Response(payload); },
    databases: { subjects: "legacy_subjects", entities: "legacy_entities", activations: "legacy_activations" } };
  f.inventory.databaseCounts = { subjects: count, entities: count }; f.inventory.namespaces = subjects.map(s => ({ name: s._id, credentialCount: 1 }));
  return { ...f, root, subjects, entities, payload, client, calls, attachmentCalls, drift: () => sequence++ };
}
test("portable OpenWhisk export paginates every tenant and preserves code, credentials and streamed binary attachments", async () => {
  const f = couchFixture();
  try {
    const files = await collectOpenWhisk(f.inventory, f.plan, f.root, f.read, f.client);
    const manifest = JSON.parse(readFileSync(join(f.root, "openwhisk-export.json"), "utf8"));
    expect(manifest.databases.map((d: any) => d.documents)).toEqual([523, 523]);
    expect(manifest.namespaces).toHaveLength(523);
    expect(manifest.otherDatabasesCoveredBy.names).toEqual(["legacy_activations", "extra_data"]);
    expect(f.calls.filter(c => c.includes("/_all_docs"))).toHaveLength(6);
    expect(f.attachmentCalls).toHaveLength(1); expect(f.attachmentCalls[0]).toContain("?rev=1-entity");
    const attachment = manifest.attachments[0]; expect(attachment.path).toMatch(/^attachments\/[a-f0-9]{64}\.bin$/);
    expect(readFileSync(join(f.root, attachment.path))).toEqual(f.payload);
    expect(readFileSync(join(f.root, "database-1.ndjson"), "utf8")).toContain(CANARY);
    expect(files.every(file => statSync(join(f.root, file.path)).mode % 0o1000 === 0o600)).toBe(true);
    expect(JSON.stringify(files)).not.toContain(CANARY);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test("attachment truncation, wrong declared counts and source drift stop portable export", async () => {
  const f = couchFixture(2);
  try {
    f.client.attachment = async () => new Response("truncated");
    await expect(collectOpenWhisk(f.inventory, f.plan, f.root, f.read, f.client)).rejects.toThrow("size_mismatch");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
  const g = couchFixture(2);
  try {
    const original = g.client.get;
    g.client.get = async path => { if (path.includes("legacy_entities/_all_docs")) g.drift(); return original(path); };
    await expect(collectOpenWhisk(g.inventory, g.plan, g.root, g.read, g.client)).rejects.toThrow("changed_during_read");
  } finally { rmSync(g.root, { recursive: true, force: true }); }
});
