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
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { selectTarget, hash, canonical } from "./releases";

const root = resolve(import.meta.dir, "..");
const directory = join(import.meta.dir, "lab/baseline-0.9.0-20261027");
const index = join(import.meta.dir, "lab/index.json");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("enrolled lab index selects the exact frozen target without a manifest override", async () => {
  const target = await selectTarget({ root, index, channel: "preview" });
  expect(target.selection).toBe("lab_index");
  expect(target.release?.id).toBe("baseline-0.9.0-lab.20261027");
  expect(target.release?.status).toBe("local");
  expect(target.release?.tasks.commit).toBe("14a6eca5a40d274dfe43b84b0a2f1e9d66cb7e36");
  expect((await selectTarget({ root, index, channel: "preview", to: target.release!.id })).manifestSha256)
    .toBe(target.manifestSha256);
  expect((await selectTarget({ root, index, channel: "stable" })).release).toBeNull();
  expect((await selectTarget({ root, channel: "preview" })).release).toBeNull();
});
test("enrolled snapshot contains the entire platform and runtime catalogs", () => {
  const manifest = json(join(directory, "manifest.json"));
  const config = json(join(root, "opsroot.json"));
  expect(Object.keys(manifest.images).sort()).toEqual(Object.keys(config.config.images).sort());
  expect(Object.keys(manifest.images).length).toBe(39);
  const runtimes = json(join(directory, "runtimes.json"));
  expect(hash(canonical(runtimes))).toBe(manifest.runtimes.sha256);
  expect(runtimes).toEqual(json(join(root, "runtimes.json")));
  expect(Object.values(runtimes.runtimes).flat().length).toBe(14);
  expect(manifest.cli.sha256).toMatch(/^[a-f0-9]{64}$/);
});
test("enrolled artifact byte checksums detect changes to every bundled JSON file", () => {
  const sums = readFileSync(join(directory, "SHA256SUMS"), "utf8").trim().split("\n");
  expect(sums.length).toBe(3);
  for (const line of sums) {
    const match = line.match(/^([a-f0-9]{64})  ([a-z]+\.json)$/);
    expect(match).not.toBeNull();
    expect(hash(readFileSync(join(directory, match![2])))).toBe(match![1]);
  }
});
test("lab evidence distinguishes local and unverified images from observed pod IDs", () => {
  const snapshot = json(join(directory, "observations.json"));
  const manifest = json(join(directory, "manifest.json"));
  expect(snapshot.portable).toBe(false);
  expect(snapshot.freshInstallValidated).toBe(false);
  expect(snapshot.registryAvailabilityChecked).toBe(false);
  expect(snapshot.observedImageIdsAreRegistryManifestDigests).toBe(false);
  expect(snapshot.taskCommit).toBe(manifest.tasks.commit);
  expect(Object.keys(snapshot.images).sort()).toEqual(Object.keys(manifest.images).sort());
  const images = Object.entries(snapshot.images) as [string, any][];
  expect(images.filter(([, value]) => value.verification === "observed_on_baseline").length).toBe(27);
  expect(images.filter(([, value]) => value.availability === "lab_local").map(([key]) => key).sort())
    .toEqual(["operator", "streamer", "systemapi"]);
  for (const [key, row] of images) {
    expect(row.reference).toBe(manifest.images[key]);
    for (const digest of row.observedImageIds) expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  }
  for (const privateField of ["clusterUid", "namespaceUid", "password", "secret", "/root/", "192.168."])
    expect(JSON.stringify(snapshot)).not.toContain(privateField);
});
