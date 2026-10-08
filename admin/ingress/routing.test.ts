// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements. See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership. The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License. You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

for (const provider of ["nginx", "traefik"]) {
  for (const tls of [false, true]) {
    test(`${provider}, TLS=${tls}: streamer does not claim tenant static root`, () => {
      const source = readFileSync(new URL(`${provider}-template.yaml`, import.meta.url), "utf8")
        .replaceAll("${USERNAME}", "tenant")
        .replaceAll("${BASE_HOST:-localhost}", "example.test")
        .replaceAll("$T", tls ? "" : "#")
        .replaceAll("$$", "$");
      const docs = source.split(/^---\s*$/m).filter(x => x.trim()).map(x => Bun.YAML.parse(x) as any).filter(Boolean);
      const ingress = (name: string) => docs.find(x => x.kind === "Ingress" && x.metadata.name === name);
      const root = ingress("tenant-my-streamer-ingress");
      expect(root.spec.rules[0].host).toBe("tenant.example.test");
      expect(root.spec.rules[0].http.paths.map((p: any) => p.path)).toEqual(["/web", "/action"]);
      for (const p of root.spec.rules[0].http.paths) {
        expect(p.pathType).toBe("Prefix");
        expect(p.backend.service.name).toBe("openserverless-streamer-api");
      }
      const web = ingress("tenant-my-streamer-web-ingress");
      const action = ingress("tenant-my-streamer-action-ingress");
      expect(web.spec.rules[0].http.paths[0].path.startsWith("/stream/web")).toBe(true);
      expect(action.spec.rules[0].http.paths[0].path.startsWith("/stream/action")).toBe(true);
      const s3 = ingress("tenant-my-s3-ingress");
      expect(s3.spec.rules[0].http.paths.map((p: any) => p.path)).toEqual(["/tenant-web", "/tenant-data"]);
      expect(s3.metadata.annotations["nginx.ingress.kubernetes.io/rewrite-target"]).toBeUndefined();
      expect(s3.metadata.annotations["traefik.ingress.kubernetes.io/router.middlewares"]).toBeUndefined();
    });
  }
}
