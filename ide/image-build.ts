// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements. See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, relative, isAbsolute } from "node:path";
import { expandEnv } from "./deploy/env_utils.js";

type Recipe = {
  image: string;
  source: string;
  kind: string;
  requirements: string;
  registryUrl?: string;
  registryAuthHost?: string;
  kubeNamespace?: string;
  apiHost?: string;
  platform?: string;
  timeoutSeconds?: number;
};
const root = () => resolve(process.env.OPS_PWD || process.cwd());
const pending = new Map<string, Promise<void>>();
const manifestTypes = ["application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.docker.distribution.manifest.v2+json"].join(", ");

async function jsonFile(path: string, optional = false): Promise<any> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error: any) { if (optional && error.code === "ENOENT") return {}; throw new Error(`Cannot read JSON configuration: ${path}`); }
}

/** Read build recipes without changing project sources or action directives. */
async function recipes(): Promise<Recipe[]> {
  const project = await jsonFile(join(root(), "package.json"), true);
  const config = project.openserverless?.build;
  if (!config) return [];
  const items = Array.isArray(config) ? config : [config];
  const result = items.map((item: any) => {
    if (!item || typeof item !== "object") throw new Error("openserverless.build must be an object or array of objects");
    const r: any = { kind: "python", requirements: "requirements.txt", ...item };
    for (const key of ["image", "source", "requirements", "registryUrl", "registryAuthHost", "apiHost", "kubeNamespace", "platform"]) {
      if (r[key] !== undefined) {
        if (typeof r[key] !== "string") throw new Error(`Build setting ${key} must be a string`);
        r[key] = expandEnv(r[key]);
      }
    }
    if (!r.image || !r.source) throw new Error("Each build recipe requires image and source");
    return r as Recipe;
  });
  if (new Set(result.map(r => r.image)).size !== result.length) throw new Error("Each image must have exactly one build recipe");
  return result;
}

function imageParts(image: string) {
  if (!image || /[\s\x00-\x1f]/.test(image) || image.includes("://") || image.split("@").length > 2) throw new Error("Invalid container image reference");
  const first = image.split("/")[0];
  const explicit = image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  const host = explicit ? first : "docker.io";
  if (!/^[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(host)) throw new Error("Invalid image registry hostname");
  let name = explicit ? image.slice(first.length + 1) : image;
  let reference = "latest";
  if (name.includes("@")) [name, reference] = name.split("@");
  else if (name.lastIndexOf(":") > name.lastIndexOf("/")) {
    reference = name.slice(name.lastIndexOf(":") + 1); name = name.slice(0, name.lastIndexOf(":"));
  }
  if (host === "docker.io" && !name.includes("/")) name = `library/${name}`;
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(name)
      || !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|sha256:[a-f0-9]{64})$/.test(reference)) throw new Error("Invalid image repository or tag");
  return { host, name, reference };
}

async function command(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { cwd: root(), env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, , status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (status !== 0) throw new Error(`${args[0]} ${args[1] || ""} failed (exit ${status}); check cluster access and context`);
  return stdout;
}

/** Credentials stay in memory and never appear in command arguments or logs. */
async function registryAuth(host: string, recipe?: Recipe): Promise<string | undefined> {
  const authHost = recipe?.registryAuthHost || host;
  const docker = await jsonFile(join(process.env.DOCKER_CONFIG || join(homedir(), ".docker"), "config.json"), true);
  const find = (config: any) => {
    const entry = config.auths?.[authHost] || config.auths?.[`https://${authHost}`]
      || (authHost === "docker.io" ? config.auths?.["https://index.docker.io/v1/"] : undefined);
    if (entry?.auth) return `Basic ${entry.auth}`;
    if (entry?.username && entry?.password) return `Basic ${Buffer.from(`${entry.username}:${entry.password}`).toString("base64")}`;
    return undefined;
  };
  const local = find(docker);
  if (local) return local;
  const helper = docker.credHelpers?.[authHost] || docker.credsStore;
  if (helper && /^[a-zA-Z0-9_-]+$/.test(helper)) {
    const proc = Bun.spawn([`docker-credential-${helper}`, "get"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(authHost + "\n"); proc.stdin.end();
    const [out, , status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (status === 0) {
      const credential = JSON.parse(out);
      if (credential.Username && credential.Secret) return `Basic ${Buffer.from(`${credential.Username}:${credential.Secret}`).toString("base64")}`;
    }
  }
  try {
    const ns = recipe?.kubeNamespace || process.env.OPS_BUILD_KUBE_NAMESPACE || "openserverless";
    const secret = JSON.parse(await command(["kubectl", "-n", ns, "get", "secret", "registry-pull-secret", "-o", "json"]));
    return find(JSON.parse(Buffer.from(secret.data[".dockerconfigjson"], "base64").toString()));
  } catch { return undefined; } // Registry response below remains authoritative (401 is never "missing").
}

async function request(url: string, init: RequestInit = {}, timeout = 30000) {
  try { return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) }); }
  catch { throw new Error(`Cannot reach ${new URL(url).origin}; check network, TLS and registry configuration`); }
}

/** Only a registry 404 means an absent image. Authentication/network errors stop deployment. */
async function imageExists(image: string, recipe?: Recipe): Promise<boolean> {
  const { host, name, reference } = imageParts(image);
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const origin = recipe?.registryUrl || `${local ? "http" : "https"}://${host === "docker.io" ? "registry-1.docker.io" : host}`;
  const base = new URL(origin);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("registryUrl must be an HTTP(S) origin without credentials or path");
  const url = `${base.origin}/v2/${name}/manifests/${reference}`;
  const headers: Record<string, string> = { Accept: manifestTypes };
  let response = await request(url, { method: "HEAD", headers });
  if (response.status === 401) {
    const auth = await registryAuth(host, recipe);
    const challenge = response.headers.get("www-authenticate") || "";
    if (/^Bearer\s/i.test(challenge)) {
      const params = Object.fromEntries([...challenge.matchAll(/([a-z_]+)="([^"]*)"/gi)].map(m => [m[1].toLowerCase(), m[2]]));
      if (!params.realm) throw new Error("Registry Bearer challenge has no realm");
      const tokenUrl = new URL(params.realm);
      if (tokenUrl.protocol !== "https:" && tokenUrl.origin !== base.origin) throw new Error("Registry token endpoint must use HTTPS or the same registry origin");
      if (tokenUrl.username || tokenUrl.password) throw new Error("Invalid registry token endpoint");
      if (params.service) tokenUrl.searchParams.set("service", params.service);
      tokenUrl.searchParams.set("scope", params.scope || `repository:${name}:pull`);
      const tokenResponse = await request(tokenUrl.toString(), { headers: auth ? { Authorization: auth } : {} });
      if (!tokenResponse.ok) throw new Error(`Registry authentication failed (HTTP ${tokenResponse.status})`);
      const token = await tokenResponse.json();
      if (!token.token && !token.access_token) throw new Error("Registry authentication returned no token");
      headers.Authorization = `Bearer ${token.token || token.access_token}`;
    } else if (auth && /^Basic\s/i.test(challenge)) headers.Authorization = auth;
    else throw new Error(`Registry access denied for ${image}; configure credentials (HTTP 401)`);
    response = await request(url, { method: "HEAD", headers });
  }
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Registry check failed for ${image} (HTTP ${response.status})`);
  return true;
}

async function whiskProperties(): Promise<Record<string, string>> {
  const path = process.env.WSK_CONFIG_FILE || join(homedir(), ".wskprops");
  const text = await readFile(path, "utf8");
  const properties: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) properties[match[1]] = match[2].trim();
  }
  return properties;
}

/** Submit a native build, wait for the exact returned Job, then verify the published manifest. */
async function buildImage(image: string, recipe: Recipe): Promise<void> {
  const { name, reference } = imageParts(image);
  if (reference.startsWith("sha256:")) throw new Error("A missing digest cannot be rebuilt; choose a tagged image");
  const props = await whiskProperties();
  const ns = (props.NAMESPACE && props.NAMESPACE !== "_" ? props.NAMESPACE : process.env.OPSDEV_USERNAME || process.env.OPS_USER)?.toLowerCase();
  if (!ns || name !== ns) throw new Error(`System API builds require the image repository to match the authenticated namespace (${ns || "unknown"}). Configure image as <registry>/${ns || "username"}:<tag>; existing legacy images can still be reused.`);
  imageParts(recipe.source); // Validate source before submitting shell-facing API fields.
  if (!["python", "nodejs", "php", "java", "go", "ruby", "dotnet"].includes(recipe.kind)) throw new Error("Unsupported build kind");
  const projectRoot = await realpath(root());
  const requirementPath = await realpath(resolve(projectRoot, recipe.requirements));
  const rel = relative(projectRoot, requirementPath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Requirements must be inside the project directory");
  const requirements = await readFile(requirementPath);
  if (requirements.length > 700000) throw new Error("Requirements exceed the Kubernetes build-context size limit");
  const kubeNs = recipe.kubeNamespace || process.env.OPS_BUILD_KUBE_NAMESPACE || "openserverless";
  if (recipe.platform) {
    const nodes = JSON.parse(await command(["kubectl", "get", "nodes", "-o", "json"]));
    const platforms = new Set(nodes.items.map((n: any) => `linux/${n.status.nodeInfo.architecture}`));
    if (platforms.size !== 1 || !platforms.has(recipe.platform)) throw new Error("System API currently builds for the node architecture; the requested platform does not match this cluster");
  }
  const auth = process.env.OPS_BUILD_AUTH || props.AUTH;
  if (!auth) throw new Error("Missing OpenWhisk authorization; run ops ide login");
  const host = recipe.apiHost || process.env.OPSDEV_APIHOST || process.env.OPS_APIHOST || props.APIHOST;
  if (!host) throw new Error("Missing API host; run ops ide login");
  const api = new URL("/system/api/v1/build/start", host.includes("://") ? host : `https://${host}`);
  const seconds = recipe.timeoutSeconds ?? 1800;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error("timeoutSeconds must be between 1 and 86400");
  console.log(`Building ${image} through System API`);
  const response = await request(api.toString(), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ source: recipe.source, target: `${ns}:${reference}`, kind: recipe.kind, file: requirements.toString("base64") }),
  }, 180000); // The API can wait up to 120s for the Job's init container.
  if (!response.ok) throw new Error(`System API rejected the build (HTTP ${response.status}); inspect system-api logs`);
  const result = await response.json();
  // The API response builder merges data into the top-level object; accept both layouts.
  const job = result.job_name || result.data?.job_name;
  if (!job || !/^build-[a-z0-9-]+$/.test(job)) throw new Error("System API did not return a valid build Job name");
  console.log(`Waiting for ${kubeNs}/${job} (up to ${seconds}s)`);
  const deadline = Date.now() + seconds * 1000;
  let finished = false;
  while (Date.now() < deadline) {
    const status = JSON.parse(await command(["kubectl", "-n", kubeNs, "get", "job", job, "-o", "json"])).status || {};
    if (status.failed || status.conditions?.some((c: any) => c.type === "Failed" && c.status === "True")) throw new Error(`Image build failed. Inspect: kubectl -n ${kubeNs} logs job/${job} -c buildkit`);
    if (status.succeeded || status.conditions?.some((c: any) => c.type === "Complete" && c.status === "True")) { finished = true; break; }
    await Bun.sleep(2000);
  }
  if (!finished) throw new Error(`Image build timed out; Job ${kubeNs}/${job} was left available for inspection`);
  if (!await imageExists(image, recipe)) throw new Error("Build Job completed, but the requested image is absent. Check registry_host, registryUrl and image repository mapping.");
  console.log(`Image ready: ${image}`);
}

/** Shared by the public build task and ide deploy; coalesce concurrent image checks. */
export async function ensureImage(image: string, options: { dryRun?: boolean; force?: boolean; fromDeploy?: boolean } = {}): Promise<void> {
  if (options.dryRun) { console.log(`[dry-run] Check ${image}; run ops ide build if absent`); return; }
  if (pending.has(image) && !options.force) return pending.get(image);
  const operation = (async () => {
    const recipe = (await recipes()).find(r => r.image === image);
    if (!options.force && await imageExists(image, recipe)) { console.log(`Reusing image: ${image}`); return; }
    if (!recipe) throw new Error(`Image ${image} is missing and has no matching package.json openserverless.build recipe; declare image, source and requirements`);
    if (options.fromDeploy) {
      console.log(`Image absent; running ops ide build ${image}`);
      const proc = Bun.spawn([process.env.OPS || "ops", "ide", "build", image], {
        cwd: root(), env: process.env, stdout: "inherit", stderr: "inherit",
      });
      if (await proc.exited !== 0) throw new Error(`ops ide build failed for ${image}; deployment stopped`);
      if (!await imageExists(image, recipe)) throw new Error(`Image ${image} is still absent after ops ide build`);
    } else await buildImage(image, recipe);
  })();
  pending.set(image, operation);
  try { await operation; } finally { pending.delete(image); }
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes("--dry-run"); const force = argv.includes("--force");
    if (argv.some(arg => arg.startsWith("--") && !["--dry-run", "--force"].includes(arg))) throw new Error("Unknown build option");
    const selected = argv.filter(arg => !arg.startsWith("--"));
    if (!selected.length && process.env.OPS_BUILD_SELECTED_IMAGE) selected.push(process.env.OPS_BUILD_SELECTED_IMAGE);
    if (selected.length > 1) throw new Error("Usage: ops ide build [image] [--force] [--dry-run]");
    const items = await recipes();
    const images = selected.length ? selected : [...new Set(items.map(r => r.image))];
    if (!images.length) throw new Error("No build image configured; declare package.json openserverless.build");
    for (const image of images) await ensureImage(image, { dryRun, force });
  } catch (error: any) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
