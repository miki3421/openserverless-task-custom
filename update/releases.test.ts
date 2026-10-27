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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hash, compareVersions, validateRelease, selectTarget, readDocument, httpsURL } from "./releases";

test("HTTPS metadata uses GET with no redirects and enforces streamed limits", async () => {
  const original = globalThis.fetch;
  const calls: any[] = [];
  try {
    globalThis.fetch = (async (_url: any, init: any) => {
      calls.push(init);
      return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    expect((await readDocument("https://example.org/index.json")).value).toEqual({ ok: true });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].redirect).toBe("error");
    expect(calls[0].signal).toBeDefined();
    globalThis.fetch = (async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1))) as typeof fetch;
    await expect(readDocument("https://example.org/oversized.json")).rejects.toThrow("size");
    globalThis.fetch = (async () => new Response("denied", { status: 403 })) as typeof fetch;
    await expect(readDocument("https://example.org/forbidden.json")).rejects.toThrow("403");
  } finally { globalThis.fetch = original; }
});


const hex = "a".repeat(64);
function release(extra: any = {}): any {
  return { schemaVersion: 1, id: "release-0.9.1", version: "0.9.1", distribution: "apache",
    channel: "preview", status: "published", publishedAt: "2026-10-27T00:00:00Z",
    cli: { version: "0.9.1", platform: "linux_amd64", sha256: hex },
    tasks: { repository: "https://github.com/example/tasks", commit: "b".repeat(40) },
    runtimes: { sha256: hex }, images: { nginx: "nginx:1.25" },
    kubernetes: { minVersion: "1.33.0", maxVersionExclusive: "1.37.0" }, ...extra };
}
function temp(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ops-releases-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
test("semantic precedence handles numeric and prerelease identifiers, ignoring build metadata", () => {
  const ascending = ["0.9.0-alpha", "0.9.0-alpha.2", "0.9.0-alpha.10", "0.9.0-beta", "0.9.0-rc.1", "0.9.0", "0.10.0", "1.0.0"];
  for (let i = 0; i < ascending.length - 1; i++) {
    expect(compareVersions(ascending[i], ascending[i + 1])).toBe(-1);
    expect(compareVersions(ascending[i + 1], ascending[i])).toBe(1);
  }
  expect(compareVersions("v1.36.4+k3s1", "1.36.4")).toBe(0);
  expect(() => compareVersions("latest", "1.0.0")).toThrow();
  for (const invalid of ["1.0.0-alpha..1", "1.0.0-01", "1.0.0+", "01.0.0"])
    expect(() => compareVersions(invalid, "1.0.0")).toThrow();
});
test("canonical hashing is order independent for objects but not arrays", () => {
  expect(hash(canonical({ b: [1, 2], a: 3 }))).toBe(hash(canonical({ a: 3, b: [1, 2] })));
  expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
});
test("release validation rejects incomplete pins and unsupported distributions", () => {
  for (const extra of [{ schemaVersion: 2 }, { distribution: "adv" }, { cli: { version: "0.9.1" } },
    { tasks: { commit: "main" } }, { runtimes: {} }, { images: {} },
    { kubernetes: { minVersion: "1.37.0", maxVersionExclusive: "1.33.0" } }, { publishedAt: "yesterday" }])
    expect(() => validateRelease(release(extra))).toThrow();
  const result = validateRelease({ ...release(), password: "must-not-survive" });
  expect(JSON.stringify(result)).not.toContain("must-not-survive");
});
test("stable requires published, immutable images and downloadable artifacts", () => {
  expect(() => validateRelease(release({ channel: "stable" }))).toThrow();
  const stable = release({ channel: "stable", images: { nginx: "nginx@sha256:" + hex },
    cli: { version: "0.9.1", platform: "linux_amd64", sha256: hex, url: "https://example.org/ops" },
    runtimes: { sha256: hex, url: "https://example.org/runtimes.json" } });
  expect(validateRelease(stable).channel).toBe("stable");
  for (const extra of [{ status: "local" }, { id: "0.9.1-snapshot" }, { version: "0.9.1-rc1" }])
    expect(() => validateRelease({ ...stable, ...extra })).toThrow();
});
test("artifact URLs reject credentials, fragments and plaintext protocols", () => {
  for (const url of ["http://example.org/x", "file:///etc/passwd", "https://user:secret@example.org/x", "https://example.org/x#token"])
    expect(() => httpsURL(url)).toThrow();
});
test("explicit local manifests require matching channel and exact --to", async () => temp(async dir => {
  const manifest = join(dir, "manifest.json");
  writeFileSync(manifest, JSON.stringify(release({ status: "local" })));
  const options = { root: dir, manifest, channel: "preview" as const };
  expect((await selectTarget(options)).release?.id).toBe("release-0.9.1");
  await expect(selectTarget({ ...options, channel: "stable" })).rejects.toThrow();
  await expect(selectTarget({ ...options, to: "different" })).rejects.toThrow();
}));
test("latest index selects highest SemVer, excludes withdrawn and wrong-channel releases", async () => temp(async dir => {
  const entries: any[] = [];
  for (const [id, version, channel, withdrawn] of [
    ["older", "0.9.9", "preview", false], ["latest", "0.10.0", "preview", false],
    ["withdrawn", "1.0.0", "preview", true], ["stable", "2.0.0", "stable", false]
  ] as const) {
    const doc = JSON.stringify(release({ id, version, channel: "preview" }));
    writeFileSync(join(dir, id + ".json"), doc);
    entries.push({ id, version, channel, status: "published", withdrawn,
      publishedAt: "2026-10-27T00:00:00Z", manifest: id + ".json", sha256: hash(doc) });
  }
  const index = join(dir, "index.json");
  writeFileSync(index, JSON.stringify({ schemaVersion: 1, releases: entries }));
  const options = { root: dir, index, channel: "preview" as const };
  expect((await selectTarget(options)).release?.id).toBe("latest");
  expect((await selectTarget({ ...options, to: "older" })).release?.id).toBe("older");
  expect((await selectTarget({ ...options, to: "withdrawn" })).release).toBeNull();
  entries[1].sha256 = "0".repeat(64);
  writeFileSync(index, JSON.stringify({ schemaVersion: 1, releases: entries }));
  await expect(selectTarget(options)).rejects.toThrow("checksum");
}));
test("index rejects manifest identity substitution even with a matching checksum", async () => temp(async dir => {
  const doc = JSON.stringify(release());
  writeFileSync(join(dir, "release.json"), doc);
  const index = join(dir, "index.json");
  writeFileSync(index, JSON.stringify({ schemaVersion: 1, releases: [{
    id: "substituted", version: "0.9.1", channel: "preview", status: "published",
    publishedAt: "2026-10-27T00:00:00Z", manifest: "release.json", sha256: hash(doc)
  }] }));
  await expect(selectTarget({ root: dir, index, channel: "preview" })).rejects.toThrow("identity");
}));
test("empty index reports unavailable; invalid and oversized local documents fail safely", async () => temp(async dir => {
  const index = join(dir, "index.json");
  writeFileSync(index, '{"schemaVersion":1,"releases":[]}');
  expect((await selectTarget({ root: dir, index, channel: "stable" })).release).toBeNull();
  writeFileSync(index, '{"sensitive":"DO_NOT_ECHO"');
  try { await readDocument(index); throw Error("should fail"); }
  catch (error) { expect(String(error)).not.toContain("DO_NOT_ECHO"); }
  writeFileSync(index, " ".repeat(2 * 1024 * 1024 + 1));
  await expect(readDocument(index)).rejects.toThrow();
  await expect(readDocument("http://example.org/index.json")).rejects.toThrow("HTTPS");
}));

test("local lab index selects a pinned preview target and verifies its runtime artifact", async () => temp(async dir => {
  const runtime = { runtimes: { python: [{ kind: "python:default" }] } };
  const doc = JSON.stringify(release({ status: "local", runtimes: { sha256: hash(canonical(runtime)) } }));
  writeFileSync(join(dir, "manifest.json"), doc);
  writeFileSync(join(dir, "runtimes.json"), JSON.stringify(runtime));
  const index = join(dir, "index.json");
  const entry = { id: "release-0.9.1", version: "0.9.1", channel: "preview", status: "local",
    publishedAt: "2026-10-27T00:00:00Z", manifest: "manifest.json", sha256: hash(doc), runtimes: "runtimes.json" };
  const writeIndex = (entries = [entry], scope: any = "lab") =>
    writeFileSync(index, JSON.stringify({ schemaVersion: 1, ...(scope ? { scope } : {}), releases: entries }));
  writeIndex();
  const options = { root: dir, index, channel: "preview" as const };
  expect((await selectTarget(options)).selection).toBe("lab_index");
  expect((await selectTarget({ ...options, to: entry.id })).release?.id).toBe(entry.id);
  expect((await selectTarget({ ...options, channel: "stable" })).release).toBeNull();
  expect((await selectTarget({ ...options, to: "missing" })).release).toBeNull();
  writeIndex([{ ...entry, withdrawn: true }]);
  expect((await selectTarget(options)).release).toBeNull();
  // Omitted/unknown scope cannot promote a local target into published selection.
  writeIndex([entry], null);
  expect((await selectTarget(options)).release).toBeNull();
  writeIndex([{ ...entry, runtimes: "https://example.org/runtimes.json" }]);
  await expect(selectTarget(options)).rejects.toThrow("local files");
  writeIndex();
  writeFileSync(join(dir, "runtimes.json"), '{"runtimes":{}}');
  await expect(selectTarget(options)).rejects.toThrow("runtime artifact checksum");
}));

test("lab catalog rejects publication, remote artifacts and mixed channels", async () => temp(async dir => {
  const index = join(dir, "index.json");
  const entry = { id: "release-0.9.1", version: "0.9.1", channel: "preview", status: "local",
    publishedAt: "2026-10-27T00:00:00Z", manifest: "https://example.org/local.json", sha256: hex };
  for (const change of [{ channel: "stable" }, { status: "published" }, {}]) {
    writeFileSync(index, JSON.stringify({ schemaVersion: 1, scope: "lab", releases: [{ ...entry, ...change }] }));
    await expect(selectTarget({ root: dir, index, channel: "preview" })).rejects.toThrow();
  }
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ schemaVersion: 1, scope: "lab", releases: [] }))) as typeof fetch;
    await expect(selectTarget({ root: dir, index: "https://example.org/lab.json", channel: "preview" })).rejects.toThrow("local files");
  } finally { globalThis.fetch = original; }
}));
