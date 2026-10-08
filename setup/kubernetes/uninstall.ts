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

export type Kube = (args: string[]) => Promise<any>;
const ns = ["-n", "openserverless"];
const json = ["--ignore-not-found", "-o", "json"];

export async function uninstall(kube: Kube) {
  const namespace = await kube(["get", "namespace", "openserverless", ...json]);
  if (!namespace) {console.log("OpenServerless namespace is already absent.");return;}
  const crds = await kube(["get", "crd", "whisksusers.openserverless.org", "whisks.openserverless.org", "kubegres.kubegres.reactive-tech.io", ...json]);
  const has = (name: string) => (crds?.items ?? []).some((c: any) => c.metadata.name === name);
  const users = has("whisksusers.openserverless.org") ? (await kube(["get", "wsku", ...ns, "-o", "json"])).items : [];
  const whisks = has("whisks.openserverless.org") ? (await kube(["get", "whisk", ...ns, "-o", "json"])).items : [];
  if (users.length || whisks.length) {
    const operator = await kube(["get", "sts", "openserverless-operator", ...ns, ...json]);
    if (!operator || Number(operator.status?.readyReplicas ?? 0) < 1) {
      throw new Error("The OpenServerless operator must be Ready to finalize its users and Whisk resources. Restore it before retrying; finalizers were not removed.");
    }
  }
  for (const [kind, resources] of [["wsku", users], ["whisk", whisks]] as const) {
    for (const obj of resources) {
      console.log(`Removing ${kind}/${obj.metadata.name} with the operator still running.`);
      await kube(["delete", kind, obj.metadata.name, ...ns, "--ignore-not-found", "--wait=true", "--timeout=180s"]);
    }
  }
  if (has("kubegres.kubegres.reactive-tech.io")) {
    const databases = (await kube(["get", "kubegres", ...ns, "-o", "json"])).items;
    for (const db of databases) {
      await kube(["delete", "kubegres", db.metadata.name, ...ns, "--ignore-not-found", "--wait=true", "--timeout=180s"]);
    }
  }
  console.log("Managed custom resources finalized; removing the OpenServerless namespace.");
  await kube(["delete", "namespace", "openserverless", "--ignore-not-found", "--wait=true", "--timeout=300s"]);
  console.log("OpenServerless namespace removed. Other namespaces and cluster-wide CRDs were retained.");
}

const kube: Kube = async args => {
  const child = Bun.spawn(["kubectl", ...args], {stdout:"pipe",stderr:"pipe"});
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if (code !== 0) throw new Error(`kubectl ${args.slice(0,3).join(" ")} failed (${code}): ${err.trim()}`);
  return args.includes("json") ? (out.trim() ? JSON.parse(out) : undefined) : out;
};
if (import.meta.main) {
  try {await uninstall(kube)} catch(error) {console.error(`ERROR: ${(error as Error).message}`);process.exitCode=1;}
}
