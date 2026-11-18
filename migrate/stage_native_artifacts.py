# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Offline byte verification/staging only. No download, installation or execution."""
import argparse
import bz2
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile
import urllib.parse

from qualify_arm64 import regular, require, tool_identity, wheel_identity

MAX_BINARY=160*1024**2


def bounded_copy(source,target,limit=MAX_BINARY):
    total=0
    with target.open('xb') as out:
        target.chmod(0o600)
        while block:=source.read(min(1024**2,limit-total+1)):
            total+=len(block)
            require(total<=limit,'native_expansion_budget_exceeded')
            out.write(block)
    require(total>0,'empty_native_binary')


def unpack_binary(path,target,format):
    if format=='elf':
        with path.open('rb') as src:bounded_copy(src,target)
    elif format=='bz2-elf':
        with bz2.open(path,'rb') as src:bounded_copy(src,target)
    elif format=='tar-gz-elf':
        found=False;count=0;expanded=0
        with tarfile.open(path,mode='r|gz') as archive:
            for entry in archive:
                count+=1;expanded+=entry.size
                member=PurePosixPath(entry.name)
                require(count<=4096 and expanded<=256*1024**2,'native_archive_budget_exceeded')
                require(not member.is_absolute() and '..' not in member.parts and
                        '\\' not in entry.name and (entry.isfile() or entry.isdir()),'unsafe_native_archive_member')
                if member.name=='milvus-backup':
                    require(entry.isfile() and not found and entry.size<=MAX_BINARY,'one_native_binary_required')
                    with archive.extractfile(entry) as src:bounded_copy(src,target)
                    found=True
        require(found,'native_binary_missing')
    else:raise ValueError('closed_native_artifact_format_required')
    expected=hashlib.sha256(target.read_bytes()).hexdigest()
    return tool_identity(target,expected)


def stage(manifest,source,destination):
    require(set(manifest)=={'schemaVersion','kind','platform','operationallyQualified','artifacts'} and
            type(manifest['schemaVersion']) is int and manifest['schemaVersion']==1 and
            manifest['kind']=='offline-native-artifact-inputs' and manifest['platform']=='linux/arm64' and
            manifest['operationallyQualified'] is False,'closed_native_input_manifest_required')
    rows=manifest['artifacts']
    require(type(rows) is list and {r.get('role') for r in rows}=={'k3s','restic','milvus-backup','pymongo','dnspython'} and len(rows)==5,'complete_native_input_roles_required')
    source=Path(source);destination=Path(destination)
    require(source.is_absolute() and destination.is_absolute() and not destination.exists() and
            not any(p.is_symlink() for p in (destination,*destination.parents)),'fresh_native_stage_required')
    checked=[];filenames=set()
    for row in rows:
        require(set(row)<={'role','url','sha256','bytes','format'} and
                {'role','url','sha256','format'}<=set(row),'closed_native_input_required')
        url=urllib.parse.urlsplit(row['url']);filename=Path(url.path).name
        require(url.scheme=='https' and filename and filename not in filenames,'unique_native_input_required')
        filenames.add(filename)
        path=regular(source/filename,256*1024**2)
        if 'bytes' in row:require(type(row['bytes']) is int and path.stat().st_size==row['bytes'],'native_input_size_mismatch')
        require(hashlib.sha256(path.read_bytes()).hexdigest()==row['sha256'],'native_input_digest_mismatch')
        checked.append((row,path))
    destination.mkdir(mode=0o700)
    (destination/'tools').mkdir(mode=0o700)
    result=[]
    for row,path in checked:
        if row['format']=='wheel':
            require(row['role'] in ('pymongo','dnspython'),'native_role_format_mismatch')
            proof=wheel_identity({**row,'name':row['role']},source)
        else:
            require((row['role'],row['format']) in {('k3s','elf'),('restic','bz2-elf'),('milvus-backup','tar-gz-elf')},'native_role_format_mismatch')
            proof=unpack_binary(path,destination/'tools'/row['role'],row['format'])
        result.append({'role':row['role'],'inputSha256':row['sha256'],'inputBytes':path.stat().st_size,'proof':proof})
    receipt={'schemaVersion':1,'platform':'linux/arm64','artifacts':result,
             'installed':False,'nativeRuntimeQualified':False,'migrationReady':False}
    target=destination/'receipt.json';target.write_text(json.dumps(receipt,indent=2)+'\n');target.chmod(0o600)
    return receipt


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    manifest=json.loads(Path(__file__).with_name('releases').joinpath('arm64-native-inputs.json').read_text())
    print(json.dumps(stage(manifest,args.inputs,args.output),indent=2))


if __name__=='__main__':main()
