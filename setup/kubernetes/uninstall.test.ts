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

import {test,expect} from "bun:test";
import {uninstall} from "./uninstall";
const crds = {items:["whisksusers.openserverless.org","whisks.openserverless.org","kubegres.kubegres.reactive-tech.io"].map(name => ({metadata:{name}}))};
function fake(options: {users?:string[],whisks?:string[],operatorReady?:boolean,failDelete?:string} = {}) {
  const calls:string[][]=[];
  return {calls, kube:async (args:string[]) => {
    calls.push(args);
    if (args[0]==="delete") {if (args[1]===options.failDelete) throw new Error("delete timeout");return "";}
    if (args[1]==="namespace") return {metadata:{name:"openserverless"}};
    if (args[1]==="crd") return crds;
    if (args[1]==="sts") return {status:{readyReplicas:options.operatorReady === false ? 0 : 1}};
    if (args[1]==="wsku") return {items:(options.users ?? []).map(name => ({metadata:{name}}))};
    if (args[1]==="whisk") return {items:(options.whisks ?? []).map(name => ({metadata:{name}}))};
    return {items:[]};
  }};
}
test("missing namespace is an idempotent no-op", async () => {
  const calls:string[][]=[];
  await uninstall(async args => {calls.push(args);return undefined});
  expect(calls.length).toBe(1);
});
test("users finish before Whisk and namespace; no operator or finalizer patches", async () => {
  const {calls,kube}=fake({users:["tenant-a","tenant-b"],whisks:["controller"]});
  await uninstall(kube);
  expect(calls.filter(a => a[0]==="delete").map(a=>a[1])).toEqual(["wsku","wsku","whisk","namespace"]);
  expect(calls.some(a=>a[0]==="patch")).toBe(false);
});
test("unavailable operator prevents destructive cleanup", async () => {
  const {calls,kube}=fake({users:["tenant"],operatorReady:false});
  await expect(uninstall(kube)).rejects.toThrow("operator must be Ready");
  expect(calls.some(a=>a[0]==="delete")).toBe(false);
});
test("user finalizer timeout keeps Whisk and namespace intact", async () => {
  const {calls,kube}=fake({users:["tenant"],whisks:["controller"],failDelete:"wsku"});
  await expect(uninstall(kube)).rejects.toThrow("delete timeout");
  expect(calls.filter(a=>a[0]==="delete").map(a=>a[1])).toEqual(["wsku"]);
});
test("API errors do not cause deletion", async () => {
  let mutations=0;
  await expect(uninstall(async args => {if(args[0]!=="get")mutations++;throw new Error("Forbidden")})).rejects.toThrow("Forbidden");
  expect(mutations).toBe(0);
});
test("partial cleanup without managed custom resources can finish", async () => {
  const {calls,kube}=fake();
  await uninstall(kube);
  expect(calls.filter(a=>a[0]==="delete").map(a=>a[1])).toEqual(["namespace"]);
});
