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

import {test, expect} from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {buildRuntime, runtimePlan, runtimeOptions} from "./runtime-builder";

const plan = {kind:"python", source:"runtime:3", requirements:"humanize==4.13.0"};
async function fixture(run) {
 const cache = await fs.mkdtemp(path.join(os.tmpdir(), "builder-test-"));
 try { await run({host:"http://ops.test", user:"beta", auth:"secret", cache}); }
 finally { await fs.rm(cache,{recursive:true,force:true}); }
}
test("build waits for success, verifies receipt and reuses own successful job", async()=>fixture(async ctx=>{
 let starts=0, polls=0, image;
 const fetch=async(url, options)=>{
   expect(options.redirect).toBe("error");
   if(url.endsWith("/start")){ starts++; image="registry/"+JSON.parse(options.body).target; return Response.json({job_name:"build-beta-test"}); }
   polls++;
   return Response.json({job_name:"build-beta-test",state:polls===1?"running":"succeeded",image});
 };
 const options={fetch,sleep:async()=>{},log:()=>{}};
 expect(await buildRuntime(plan,ctx,options)).toBe(image);
 expect(await buildRuntime(plan,ctx,options)).toBe(image);
 expect(starts).toBe(1); expect(polls).toBe(3);
 await buildRuntime({...plan,requirements:"humanize==4.12.0"},ctx,options);
 expect(starts).toBe(2);
}));
test("failed build and unexpected image are never cached", async()=>fixture(async ctx=>{
 for(const [state,image] of [["failed","registry/beta:wrong"],["succeeded","registry/alpha:wrong"]]) {
  const fetch=async url=>Response.json(url.endsWith("/start")?{job_name:"build-beta-test"}:{job_name:"build-beta-test",state,image});
  await expect(buildRuntime(plan,ctx,{fetch,log:()=>{}})).rejects.toThrow("action was not updated");
  expect(await fs.readdir(ctx.cache)).toEqual([]);
 }
}));
test("authentication errors are sanitized and abort", async()=>fixture(async ctx=>{
 await expect(buildRuntime(plan,ctx,{fetch:async()=>new Response("private details",{status:401}),log:()=>{}})).rejects.toThrow("Builder HTTP 401");
}));
test("monitor timeout aborts without caching",async()=>fixture(async ctx=>{
 await expect(buildRuntime(plan,ctx,{fetch:async()=>Response.json({job_name:"build-beta-test"}),timeoutMs:0,log:()=>{}})).rejects.toThrow("timed out");
 expect(await fs.readdir(ctx.cache)).toEqual([]);
}));
test("runtime directives preserve explicit base and reject combined directives",()=>{
 expect(runtimeOptions(["--docker registry/base:1", "--param value x"])).toEqual({docker:"registry/base:1"});
 expect(()=>runtimeOptions(["--kind python:3.12 --web true"])).toThrow();
});
test("plain actions remain unchanged; dependency actions resolve explicit base",async()=>fixture(async ctx=>{
 await fs.writeFile(path.join(ctx.cache,"__main__.py"),"def main(args): return args");
 expect(await runtimePlan(ctx.cache,[])).toBeNull();
 await fs.writeFile(path.join(ctx.cache,"requirements.txt"),plan.requirements);
 expect(await runtimePlan(ctx.cache,["--docker runtime:3"])).toEqual(plan);
}));
