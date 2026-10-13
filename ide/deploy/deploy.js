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

import fs from "fs/promises";
import path from "node:path";
import {runtimePlan, loginContext, buildRuntime} from "./runtime-builder.ts";
import { expandEnv } from "./env_utils";
const { parse } = await import("shell-quote");

const MAINS = ["__main__.py", "index.js", "index.php", "main.go"];

const queue = [];
const activeDeployments = new Map();

let dryRun = false;

export function setDryRun(b) {
  dryRun = b;
}

async function exec(cmd) {
  if (dryRun) { console.log("[dry-run]", cmd); return; }
  console.log("$", cmd);
  cmd = expandEnv(cmd);
  const cmdArgs = parse(cmd).filter((arg) => typeof arg === "string");

  const proc = Bun.spawn(cmdArgs, {
    shell: true,
    env: process.env,
    cwd: process.env.OPS_PWD,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`command failed (${code})`);
  }
}

async function extractArgs(files) {
  const res = [];
  for (const file of files) {
    if (await fs.exists(file)) {
      const fileContent = await fs.readFile(file, "utf-8");
      const lines = fileContent.split("\n");
      for (const line of lines) {
        // python style comment
        if (line.match(/^#[ ]?-{1,2}[^\s-].+/)) {
          res.push(line.trim().substring(1).trim());
        }
        // js style comment
        if (line.match(/^\/\/[ ]?-{1,2}[^\s-].+/)) {
          res.push(line.trim().substring(2).trim());
        }
      }
    }
  }
  return res;
}

const packageDone = new Set();

export async function deployPackage(pkg) {
  const ppath = `packages/${pkg}.args`;
  const pargs = await extractArgs([ppath]);
  const args = pargs.join(" ");
  const cmd = `ops package update ${pkg} ${args}`;
  if (!packageDone.has(cmd)) {
    await exec(cmd);
    packageDone.add(cmd);
  }
}

// Prepared runtimes are scoped to one deployment, including watch rebuilds.
const prepared = new Map();
async function prepareRuntime(pkg, action) {
  const directory = `packages/${pkg}/${action}`;
  const lines = await extractArgs(MAINS.map(m => `${directory}/${m}`));
  const plan = await runtimePlan(directory, lines);
  if (!plan) { prepared.delete(directory); return null; }
  const fingerprint = JSON.stringify(plan);
  if (prepared.get(directory)?.fingerprint === fingerprint) return prepared.get(directory).image;
  if (dryRun) { console.log(`[dry-run] Build ${plan.kind} runtime for ${pkg}/${action}`); return "dry-run"; }
  const image = await buildRuntime(plan, await loginContext());
  prepared.set(directory, {fingerprint, image});
  return image;
}

async function runtimeArchive(pkg, action) {
  const directory = path.resolve(`packages/${pkg}/${action}`);
  const artifact = `${directory}.zip`;
  if (dryRun) return `packages/${pkg}/${action}.zip`;
  const temporary = `${directory}.${crypto.randomUUID()}.zip`;
  try {
    const proc = Bun.spawn([path.join(process.env.OPS_BIN, "7zz"), "a", "-tzip", temporary, ".",
      "-xr!node_modules", "-xr!virtualenv", "-xr!.venv", "-xr!__pycache__", "-xr!.git", "-xr!.env*", "-xr!.wskprops",
      "-x!requirements.txt", "-x!package.json"], {cwd: directory, stdout: "ignore", stderr: "inherit"});
    if (await proc.exited !== 0) throw new Error("Cannot package action source.");
    await fs.rename(temporary, artifact);
  } finally { await fs.rm(temporary, {force:true}); }
  return `packages/${pkg}/${action}.zip`;
}

export async function buildZip(pkg, action) {
  if (await prepareRuntime(pkg, action)) return runtimeArchive(pkg, action);
  await exec(`ops ide util zip A=${pkg}/${action}`);
  return `packages/${pkg}/${action}.zip`;
}

export async function buildAction(pkg, action) {
  if (await prepareRuntime(pkg, action)) return runtimeArchive(pkg, action);
  await exec(`ops ide util action A=${pkg}/${action}`);
  return `packages/${pkg}/${action}.zip`;
}

export async function deployAction(artifact) {
  let pkg = "",
    name = "",
    typ = "";

  if (activeDeployments.has(artifact)) {
    queue.push(artifact);
    return;
  }

  activeDeployments.set(artifact, true);
  const indexInQueue = queue.indexOf(artifact);
  if (indexInQueue > -1) {
    console.log(`⚙️ Deploying ${artifact} (from queue: ${indexInQueue})`);
  }

  try {
    const sp = artifact.split("/");
    const spData = sp[sp.length - 1].split(".");
    name = spData[0];
    typ = spData[1];
    pkg = sp[1];
  } catch(error) {

    activeDeployments.delete(artifact);
    throw error;
  }

  let toInspect;
  if (typ === "zip") {
    const base = artifact.slice(0, -4);
    toInspect = MAINS.map((m) => `${base}/${m}`);
  } else {
    toInspect = [artifact];
  }

  try {
    const image = typ === "zip" ? await prepareRuntime(pkg, name) : null;
    if (image) await runtimeArchive(pkg, name);
    let lines = await extractArgs(toInspect);
    if (image) lines = lines.filter(line => !/^--(?:kind|docker)(?:[=\s]|$)/.test(line));
    const args = parse(expandEnv(lines.join(" "))).filter(arg => typeof arg === "string");
    if (image) args.push("--docker", image);
    await deployPackage(pkg);
    console.log(`Updating action ${pkg}/${name}`);
    if (!dryRun) {
      const proc = Bun.spawn(["ops", "action", "update", `${pkg}/${name}`, artifact, ...args], {
        env: process.env, cwd: process.env.OPS_PWD, stdio: ["inherit", "inherit", "inherit"]});
      if (await proc.exited !== 0) throw new Error(`Cannot update action ${pkg}/${name}`);
    }
  } finally {
    activeDeployments.delete(artifact);
    prepared.delete(`packages/${pkg}/${name}`);
  }

  if (queue.length > 0) {
    const nextArtifact = queue.shift();
    console.debug(`📦 deploying from queue artifact ${nextArtifact}`);
    await deploy(nextArtifact);
  }
}

/**
 * Deploy a `file`
 * @param file
 */
export async function deploy(file) {
  // Uncomment the lines below to test specific files
  // const file = "packages/deploy/hello.py";
  // const file = "packages/deploy/multi.zip";
  // const file = "packages/deploy/multi/__main__.py";
  // const file = "packages/deploy/multi/requirements.txt";

  const stat = await fs.stat(file);

  if (stat.isDirectory()) {
    for (const start of MAINS) {
      const sub = `${file}/${start}`;
      if (await fs.exists(sub)) {
        file = sub;
        break;
      }
    }
  }

  const sp = file.split("/");
  if (sp.length > 3) {
    await buildZip(sp[1], sp[2]);
    file = await buildAction(sp[1], sp[2]);
  }
  console.log(`Deploying ${file}`);
  await deployAction(file);
}

/**
 * Deploy a `manifest.yaml` file using `ops -wsk project`
 * @param artifact
 */
export async function deployProject(artifact) {
  if (await fs.exists(artifact)) {
    const manifestContent = await Bun.file(artifact).text();
    if (manifestContent.indexOf("packages:") !== -1) {
      await exec(`ops -wsk project deploy --manifest ${artifact}`);
    } else {
      console.log(
        `⚠️ Warning: it seems that the ${artifact} file is not a valid manifest file. Skipping`
      );
    }
  }
}
