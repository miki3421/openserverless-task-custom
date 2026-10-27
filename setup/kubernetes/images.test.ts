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
import { effectiveImages, validateImages, withImages } from "./images";
import { readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = JSON.parse(readFileSync(join(import.meta.dir, "../../opsroot.json"), "utf8"));
const manifest = { apiVersion: "openserverless.org/v1", kind: "Whisk", metadata: { name: "fixture" },
  spec: { components: { redis: false }, controller: { image: "old:1" }, invoker: { image: "old:1" },
    scheduler: { schedule: "*/7 * * * *" }, custom: { untouched: true } } };

test("complete catalog and explicit OPS config overrides survive rendering", () => {
  const images = effectiveImages(root, { IMAGES_REDIS: "registry.local:5443/redis:test", IMAGES_OPERATOR: "localhost/operator:test" });
  const rendered = withImages(manifest, images);
  expect(rendered.spec.images.redis).toBe("registry.local:5443/redis:test");
  expect(rendered.spec.images.operator).toBe("localhost/operator:test");
  expect(rendered.spec.controller.image).toBe(images.controller);
  expect(rendered.spec.components.redis).toBe(false);
  expect(rendered.spec.scheduler).toEqual(manifest.spec.scheduler);
  expect(rendered.spec.custom).toEqual(manifest.spec.custom);
  expect(manifest.spec.controller.image).toBe("old:1");
});

test("digest and registry port are retained byte for byte", () => {
  const image = `registry.local:5443/controller:release@sha256:${"a".repeat(64)}`;
  expect(validateImages({ controller: image }).controller).toBe(image);
});

test("malformed, empty and unversioned catalogs fail", () => {
  for (const value of [{}, [], null, { redis: "redis" }, { redis: "https://registry/redis:1" },
    { redis: "redis:1\nother:2" }, { redis: "redis@sha256:no" }, { "bad.key": "redis:1" }, { redis: 3 }]) {
    expect(() => validateImages(value)).toThrow();
  }
  expect(() => effectiveImages(root, { IMAGES_REDIS: "" })).toThrow();
});

test("render is idempotent and refuses another resource kind", () => {
  const images = effectiveImages(root, {});
  const first = withImages(manifest, images);
  expect(withImages(first, images)).toEqual(first);
  expect(() => withImages({ kind: "Deployment", spec: {} }, images)).toThrow();
});

test("command renders YAML with bundled yq and writes a private JSON manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "ops-images-test-"));
  try {
    const input = join(directory, "whisk.yaml");
    const output = join(directory, "whisk.json");
    writeFileSync(input, "apiVersion: openserverless.org/v1\nkind: Whisk\nmetadata:\n  name: fixture\nspec:\n  components:\n    redis: false\n");
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "images.ts"), "render", input, output],
      { env: { ...process.env, OPS_ROOT: join(import.meta.dir, "../..") } });
    expect(result.exitCode).toBe(0);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(output, "utf8")).spec.images.milvus).toBe(root.config.images.milvus);
    const repeated = Bun.spawnSync([process.execPath, join(import.meta.dir, "images.ts"), "render", output, output],
      { env: { ...process.env, OPS_ROOT: join(import.meta.dir, "../..") } });
    expect(repeated.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8")).spec.components.redis).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
