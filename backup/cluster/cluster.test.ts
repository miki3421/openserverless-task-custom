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

import { describe, expect, test } from "bun:test";
import { buildPlan } from "./cluster.ts";

describe("cluster backup preflight", () => {
  test("reports local-path hostPath data as an uncovered blocker", () => {
    const plan = buildPlan({
      context: "lab",
      nodes: [{ metadata: { name: "node-a" } }],
      pvs: [{
        metadata: { name: "data-pv" },
        spec: { storageClassName: "local-path", hostPath: { path: "/var/lib/rancher/k3s/storage/data" } },
        status: { phase: "Bound" },
      }],
    });

    expect(plan.volumes[0]?.source).toBe("hostPath");
    expect(plan.blockers.some((blocker) => blocker.includes("node-level backup"))).toBe(true);
  });

  test("requires an external backup location and control-plane backup", () => {
    const plan = buildPlan({ context: "lab", nodes: [], pvs: [] });

    expect(plan.blockers.some((blocker) => blocker.includes("outside this cluster"))).toBe(true);
    expect(plan.blockers.some((blocker) => blocker.includes("K3s datastore"))).toBe(true);
  });

  test("recognizes a ready Velero deployment and available location", () => {
    const plan = buildPlan({
      context: "lab",
      nodes: [{}, {}],
      pvs: [],
      veleroDeployment: { spec: { replicas: 1 }, status: { availableReplicas: 1 } },
      backupLocations: [{ metadata: { name: "primary", namespace: "velero" }, status: { phase: "Available" } }],
    });

    expect(plan.velero.ready).toBe(true);
    expect(plan.velero.locations).toEqual(["velero/primary:Available"]);
    expect(plan.blockers.some((blocker) => blocker.includes("BackupStorageLocation"))).toBe(false);
  });
});
