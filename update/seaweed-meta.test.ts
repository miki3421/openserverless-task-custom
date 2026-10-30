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

import { expect,test } from "bun:test";
import { buildSeaweedCompleteLoad,buildSeaweedMissingFileLoad,parseSeaweedMetadata } from "./seaweed-meta";
const variable=(n:number)=>{const bytes:number[]=[];do{bytes.push((n&127)|(n>127?128:0));n=Math.floor(n/128);}while(n);return Buffer.from(bytes);};
const bytes=(id:number,value:Buffer)=>Buffer.concat([variable(id*8+2),variable(value.length),value]);
function frame(parent:string,name:string,directory:boolean){
  const extended=Buffer.concat([bytes(1,Buffer.from("private-key")),bytes(2,Buffer.from("PRIVATE_METADATA_CANARY"))]);
  const entry=Buffer.concat([bytes(1,Buffer.from(name)),Buffer.from([16,directory?1:0]),bytes(9,Buffer.from([0,255,1,128])),bytes(5,extended)]);
  const value=Buffer.concat([bytes(1,Buffer.from(parent)),bytes(2,entry)]),header=Buffer.alloc(4);header.writeUInt32BE(value.length);
  return Buffer.concat([header,value]);
}
const root=()=>frame("/","",true),parent=()=>frame("/","objects",true),first=()=>frame("/objects","first",false),tail=()=>frame("/objects","last",false);
test("fresh full recovery preserves all original frames and waits after the final file",()=>{
  const original=Buffer.concat([root(),parent(),first(),tail()]);
  const result=buildSeaweedCompleteLoad(original);
  expect(result.subarray(0,original.length).equals(original)).toBe(true);
  expect(result.subarray(original.length).equals(parent())).toBe(true);
  const ready=Buffer.concat([root(),first(),parent()]);expect(buildSeaweedCompleteLoad(ready).equals(ready)).toBe(true);
  expect(()=>buildSeaweedCompleteLoad(Buffer.concat([root(),frame("/","root-file",false)]))).toThrow("barrier_unavailable");
});
test("missing-file load preserves original protobuf bytes and ends with a directory wait barrier",()=>{
  const original=Buffer.concat([root(),parent(),first(),tail()]);const before=Buffer.from(original);
  const result=buildSeaweedMissingFileLoad(original,["/objects/last"],"/objects");
  expect(result.equals(Buffer.concat([tail(),parent()]))).toBe(true);
  expect(parseSeaweedMetadata(result).map(r=>[r.path,r.directory])).toEqual([["/objects/last",false],["/objects",true]]);
  expect(original.equals(before)).toBe(true);expect(result.includes(Buffer.from("PRIVATE_METADATA_CANARY"))).toBe(true);
});
test("targeted metadata load refuses unknown files, directories and invalid barriers",()=>{
  const data=Buffer.concat([root(),parent(),first(),tail()]);
  for(const missing of [[],["/absent"],["/objects"],["/objects/last","/objects/last"]])
    expect(()=>buildSeaweedMissingFileLoad(data,missing,"/objects")).toThrow();
  for(const barrier of ["/","/objects/last","/absent"])
    expect(()=>buildSeaweedMissingFileLoad(data,["/objects/last"],barrier)).toThrow();
});
test("metadata parser rejects truncation, malformed protobuf, duplicate paths and path rewriting",()=>{
  const data=Buffer.concat([root(),parent(),first()]);
  for(const invalid of [data.subarray(0,2),data.subarray(0,data.length-1),Buffer.concat([first(),first()]),frame("/objects","../outside",false),frame("/../outside","file",false)])
    expect(()=>parseSeaweedMetadata(invalid)).toThrow();
  const malformed=Buffer.from([0,0,0,1,0]);expect(()=>parseSeaweedMetadata(malformed)).toThrow();
  const huge=Buffer.from([127,255,255,255]);expect(()=>parseSeaweedMetadata(huge)).toThrow();
});
