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
import { platformImageImportArgs, waitRegisteredNode } from "./offline";

const identity = { name: "isolated-recovery", ip: "192.0.2.10" };
const node = () => ({ kind: "Node", metadata: { name: identity.name, uid: "guest-node" },
  status: { addresses: [{ type: "InternalIP", address: identity.ip }] } });
function clock() { let t=0; return { timeoutMs: 2500, now: () => t, sleep: async (ms: number) => { t+=ms; } }; }

test("offline import selects an explicit platform and Kubernetes containerd namespace", () => {
  const args=platformImageImportArgs("/private/images with spaces.tar", "linux/amd64");
  expect(args).toEqual(["ctr","--namespace","k8s.io","images","import","--platform","linux/amd64","/private/images with spaces.tar"]);
  expect(args).not.toContain("--all-platforms");
  for (const path of ["relative.tar", "/private/../images.tar", "/private/a\nb.tar"])
    expect(() => platformImageImportArgs(path,"linux/amd64")).toThrow("invalid_offline_image_archive");
  expect(() => platformImageImportArgs("/private/images.tar","windows/amd64")).toThrow("unsupported_offline_image_platform");
});
test("node registration tolerates absence and incomplete addresses before readiness checks", async () => {
  let calls=0;
  const result=await waitRegisteredNode(async () => {
    calls++; if(calls===1) return undefined;
    if(calls===2) return {...node(),status:{}};
    return node();
  },identity,clock());
  expect(result.metadata.uid).toBe("guest-node");expect(calls).toBe(3);
});
test("node registration has a bounded deadline when the object never appears", async () => {
  let calls=0;
  await expect(waitRegisteredNode(async () => { calls++; return undefined; },identity,clock())).rejects.toThrow("registration_timeout");
  expect(calls).toBe(3);
});
test("node registration propagates failed reads and rejects foreign guest identities", async () => {
  let calls=0;
  await expect(waitRegisteredNode(async () => { calls++; throw new Error("api_denied"); },identity,clock())).rejects.toThrow("api_denied");
  expect(calls).toBe(1);
  await expect(waitRegisteredNode(async () => ({...node(),metadata:{name:"source",uid:"source-node"}}),identity,clock())).rejects.toThrow("identity_mismatch");
  await expect(waitRegisteredNode(async () => ({...node(),status:{addresses:[{type:"InternalIP",address:"192.0.2.20"}]}}),identity,clock())).rejects.toThrow("address_mismatch");
});
