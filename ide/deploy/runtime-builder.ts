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

import fs from "node:fs/promises";
import {join} from "node:path";
import {homedir} from "node:os";
import {createHash} from "node:crypto";
import {expandEnv} from "./env_utils.js";
import {parse} from "shell-quote";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const imageRef = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value);
export type Plan = {kind: string, source: string, requirements: string};
export type Context = {host: string, user: string, auth: string, cache: string};

export function runtimeOptions(lines: string[]) {
  const result: Record<string, string> = {};
  for (const line of lines) {
    if (!/^--(?:kind|docker)(?:[=\s]|$)/.test(line)) continue;
    const tokens = parse(expandEnv(line));
    const match = String(tokens[0]).match(/^--(kind|docker)(?:=(.+))?$/);
    if (!match || tokens.length !== (match[2] ? 1 : 2) || typeof (match[2] || tokens[1]) !== "string")
      throw new Error("Use a separate --kind or --docker directive with one value.");
    result[match[1]] = String(match[2] || tokens[1]);
  }
  return result;
}

export async function runtimePlan(directory: string, lines: string[]): Promise<Plan | null> {
  const python = await Bun.file(join(directory, "__main__.py")).exists();
  const node = await Bun.file(join(directory, "index.js")).exists();
  if (python && node) throw new Error("Choose one main language per dependency-bearing action directory.");
  const kind = python ? "python" : node ? "nodejs" : "";
  if (!kind) return null;
  const dependency = join(directory, python ? "requirements.txt" : "package.json");
  if (!await Bun.file(dependency).exists()) return null;
  const requirements = await fs.readFile(dependency, "utf8");
  if (!requirements.trim()) return null;
  if (Buffer.byteLength(requirements) > 500_000) throw new Error("Builder dependency manifest is too large.");
  if (node) {
    const manifest = JSON.parse(requirements);
    if (!Object.keys(manifest.dependencies || {}).length) return null;
    for (const lock of ["package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml"])
      if (await Bun.file(join(directory, lock)).exists()) throw new Error("Runtime builder does not yet support action dependency lockfiles.");
  }
  const options = runtimeOptions(lines);
  let source = options.docker;
  if (!source) {
    const catalog = JSON.parse(await fs.readFile(join(process.env.OPS_ROOT!, "runtimes.json"), "utf8"));
    const runtime = catalog.runtimes[kind]?.find((r: any) => options.kind ? r.kind === options.kind : r.default);
    if (!runtime) throw new Error("No matching base runtime in the OPS catalog.");
    source = `${runtime.image.prefix}/${runtime.image.name}:${runtime.image.tag}`;
  }
  if (!imageRef(source)) throw new Error("Invalid builder source image.");
  return {kind, source, requirements};
}

export async function loginContext(): Promise<Context> {
  const raw = await fs.readFile(join(homedir(), ".wskprops"), "utf8");
  const props = Object.fromEntries(raw.split(/\r?\n/).filter(l => l.includes("=")).map(l => {
    const at = l.indexOf("="); return [l.slice(0, at).trim(), l.slice(at + 1).trim()];
  }));
  const url = new URL(props.APIHOST);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Invalid API host; repeat ops ide login.");
  const host = url.origin;
  if (!process.env.OPSDEV_USERNAME || !props.AUTH || new URL(process.env.OPSDEV_APIHOST!).origin !== host)
    throw new Error("Login profile mismatch; repeat ops ide login.");
  return {host, user: process.env.OPSDEV_USERNAME, auth: props.AUTH,
    cache: join(process.env.OPS_TMP || join(homedir(), ".ops", "tmp"), "ide-runtime-cache")};
}

export async function buildRuntime(plan: Plan, ctx: Context, options: any = {}): Promise<string> {
  const fetcher = options.fetch || fetch;
  const pause = options.sleep || ((ms: number) => Bun.sleep(ms));
  const log = options.log || console.log;
  const hash = digest(JSON.stringify(["ops-runtime-builder-v1", ctx.host, ctx.user, plan]));
  const target = `${ctx.user}:ops-${hash}`;
  const cacheFile = join(ctx.cache, hash + ".json");
  const validImage = (s: any) => imageRef(s.image) && s.image.endsWith("/" + target);
  const call = async (path: string, payload?: any, optional = false) => {
    let response;
    try {
      response = await fetcher(ctx.host + "/system/api/v1/build/" + path, {
        method: payload ? "POST" : "GET", redirect: "error",
        headers: {Authorization: "Basic " + Buffer.from(ctx.auth).toString("base64"), "Content-Type": "application/json"},
        signal: AbortSignal.timeout(payload ? 180_000 : 20_000),
        ...(payload ? {body: JSON.stringify(payload)} : {}),
      });
    } catch { throw new Error("Builder connection failed; action was not updated."); }
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`Builder HTTP ${response.status}; action was not updated.`);
    return await response.json();
  };
  const status = async (job: string, optional = false) => {
    if (!/^build-[a-z0-9][a-z0-9.-]{0,245}$/.test(job)) throw new Error("Invalid build receipt.");
    const result = await call("status/" + encodeURIComponent(job), undefined, optional);
    if (result && (result.job_name !== job || !["pending", "running", "failed", "succeeded"].includes(result.state)))
      throw new Error("Invalid builder status response.");
    return result;
  };
  let cached;
  try { cached = JSON.parse(await fs.readFile(cacheFile, "utf8")); } catch {}
  if (cached?.job_name && /^build-[a-z0-9][a-z0-9.-]{0,245}$/.test(cached.job_name)) {
    const previous = await status(cached.job_name, true);
    if (previous?.state === "succeeded" && validImage(previous)) {
      log(`Builder: reuse ${target}`);
      return previous.image;
    }
  }
  log(`Builder: starting ${plan.kind} runtime ${target}`);
  const started = await call("start", {source: plan.source, kind: plan.kind, target,
    file: Buffer.from(plan.requirements).toString("base64")});
  const deadline = Date.now() + (options.timeoutMs ?? 960_000);
  let last = "", lastLog = 0;
  while (Date.now() < deadline) {
    const result = await status(started.job_name);
    if (result.state !== last || Date.now() - lastLog > 10_000) {
      log(`Builder ${started.job_name}: ${result.state}`); last = result.state; lastLog = Date.now();
    }
    if (result.state === "failed") throw new Error(`Build ${started.job_name} failed; action was not updated.`);
    if (result.state === "succeeded") {
      if (!validImage(result)) throw new Error("Builder returned an unexpected image; action was not updated.");
      await fs.mkdir(ctx.cache, {recursive: true, mode: 0o700});
      const tmp = cacheFile + "." + crypto.randomUUID() + ".tmp";
      await fs.writeFile(tmp, JSON.stringify({job_name: started.job_name}), {mode: 0o600});
      await fs.rename(tmp, cacheFile);
      return result.image;
    }
    await pause(options.pollMs ?? 2000);
  }
  throw new Error("Build monitoring timed out; action was not updated. The server limits builds to 15 minutes.");
}
