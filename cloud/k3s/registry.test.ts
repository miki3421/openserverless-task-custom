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

import {expect, test} from "bun:test";
import {configureRegistry, REGISTRY_CONFIG, registryConfigAction, type RemoteResult} from "./registry";

test("an empty host receives only the exact OPS registry mirror", async () => {
  const calls: {target: string; command: string; input?: string}[] = [];
  const responses: RemoteResult[] = [
    {code: 0, stdout: "", stderr: ""},
    {code: 0, stdout: "", stderr: ""},
    {code: 0, stdout: "", stderr: ""},
  ];
  const result = await configureRegistry("192.0.2.10", "ubuntu", async (target, command, input) => {
    calls.push({target, command, input});
    return responses.shift()!;
  });
  expect(result).toBe("installed");
  expect(calls).toHaveLength(3);
  expect(calls[1].target).toBe("ubuntu@192.0.2.10");
  expect(calls[1].input).toBe(REGISTRY_CONFIG);
  expect(calls[1].input).toContain('"openserverless-registry-svc:5000"');
  expect(calls[1].input).toContain('"http://127.0.0.1:32000"');
  expect(calls[1].input).not.toMatch(/password|username|docker\.io/);
  expect(calls[1].command).toContain("if test -s");
  expect(calls[1].command).toContain("mktemp");
  expect(calls[2].command).toContain("systemctl restart k3s");
});

test("the exact managed configuration is idempotent", async () => {
  let calls = 0;
  const result = await configureRegistry("k3s.example", "root", async () => {
    calls++;
    return {code: 0, stdout: REGISTRY_CONFIG.replace(/\n/g, "\r\n"), stderr: ""};
  });
  expect(result).toBe("unchanged");
  expect(calls).toBe(1);
});

test("an existing custom registry configuration is never overwritten", () => {
  expect(() => registryConfigAction('mirrors:\n  "private.example": {}\n')).toThrow("will not overwrite");
});

test("server and user cannot inject SSH options or commands", async () => {
  const unused = async () => ({code: 0, stdout: "", stderr: ""});
  await expect(configureRegistry("-oProxyCommand=id", "root", unused)).rejects.toThrow("Invalid K3s server");
  await expect(configureRegistry("k3s.example;id", "root", unused)).rejects.toThrow("Invalid K3s server");
  await expect(configureRegistry("k3s.example", "root;id", unused)).rejects.toThrow("Invalid SSH user");
});

test("remote read and write failures stop the installation", async () => {
  await expect(configureRegistry("k3s.example", "root", async () => (
    {code: 1, stdout: "", stderr: "sudo denied"}
  ))).rejects.toThrow("Unable to inspect");
  let call = 0;
  await expect(configureRegistry("k3s.example", "root", async () => {
    call++;
    return call === 1 ? {code: 0, stdout: "", stderr: ""} : {code: 1, stdout: "", stderr: "disk full"};
  })).rejects.toThrow("Unable to write");
  call = 0;
  await expect(configureRegistry("k3s.example", "root", async () => {
    call++;
    return call === 1 ? {code: 0, stdout: "", stderr: ""} : {code: 73, stdout: "", stderr: ""};
  })).rejects.toThrow("changed while OPS was configuring");
});
