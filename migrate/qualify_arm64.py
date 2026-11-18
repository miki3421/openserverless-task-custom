# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""Offline ARM64 identity audit. Never installs, downloads or executes tools."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.parse
import zipfile

TASK=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(TASK/'backup/engine/scripts'))
from platform_support import matches_platform,verify_executable

DIGEST=re.compile(r'sha256:[a-f0-9]{64}\Z')
INDEX={'application/vnd.oci.image.index.v1+json','application/vnd.docker.distribution.manifest.list.v2+json'}
IMAGE={'application/vnd.oci.image.manifest.v1+json','application/vnd.docker.distribution.manifest.v2+json'}
CONFIG={'application/vnd.oci.image.config.v1+json','application/vnd.docker.container.image.v1+json'}
TOOLS=('ops','bun','k3s','restic','milvus-backup')
GUARDS={
 'migrate/main.ts':'linux-amd64', 'migrate/target.py':'x86_64',
 'migrate/assets.py':'linux/amd64', 'migrate/source_cache.py':'linux/amd64',
 'migrate/acquisition.py':('acquisition_plan(images,fetch)','image_storage(archives)'),
 'restore/engine.py':('x86_64','linux/amd64'), 'upgrade/adapters/bootstrap_090.py':'linux/amd64',
 'upgrade/adapters/guest_library.py':'linux/amd64', 'upgrade/adapters/restore_etcd.py':r'\x3e\x00',
 'upgrade/adapters/prepare_090_tasks.py':'linux-amd64',
 'upgrade/adapters/complete.py':'linux-amd64', 'upgrade/adapters/deploy_090_apis.py':'linux-amd64',
}


def require(condition,code):
    if not condition:raise ValueError(code)


def closed_json(raw):
    def unique(pairs):
        result={}
        for key,value in pairs:
            require(key not in result,'duplicate_metadata_key');result[key]=value
        return result
    value=json.loads(raw,object_pairs_hook=unique)
    require(isinstance(value,dict),'metadata_object_required')
    return value


def regular(path,limit):
    path=Path(path)
    require(not any(p.is_symlink() for p in (path,*path.parents)),'linked_input_rejected')
    require(path.is_file() and path.stat().st_nlink==1,'regular_input_required')
    require(path.stat().st_size<=limit,'metadata_budget_exceeded')
    return path


class LocalMetadata:
    def __init__(self,directory):
        self.directory=Path(directory) if directory is not None else None
        self.documents=0;self.bytes=0
    def get(self,digest,size=None):
        require(isinstance(digest,str) and DIGEST.fullmatch(digest),'immutable_digest_required')
        require(self.directory is not None,'metadata_missing')
        path=self.directory/'blobs'/'sha256'/digest[7:]
        require(path.exists() or path.is_symlink(),'metadata_missing')
        regular(path,4*1024**2);raw=path.read_bytes()
        require('sha256:'+hashlib.sha256(raw).hexdigest()==digest,'metadata_digest_mismatch')
        if size is not None:require(type(size) is int and size>=0 and size==len(raw),'metadata_size_mismatch')
        self.documents+=1;self.bytes+=len(raw)
        require(self.documents<=512 and self.bytes<=64*1024**2,'metadata_graph_budget_exceeded')
        return closed_json(raw)


def image_identity(row,metadata):
    require(type(row) is dict and set(row)=={'reference','digest'},'closed_image_identity_required')
    require(isinstance(row['reference'],str) and re.fullmatch(r'[A-Za-z0-9._:/@-]{1,512}',row['reference']),'image_reference_required')
    digest=row['digest'];visited=set();expected_size=None
    for depth in range(8):
        require(digest not in visited,'metadata_graph_cycle');visited.add(digest)
        node=metadata.get(digest,expected_size)
        require(type(node.get('schemaVersion')) is int and node['schemaVersion']==2,'oci_schema_required')
        if node.get('mediaType') in INDEX:
            require(type(node.get('manifests')) is list,'oci_index_required')
            selected=[d for d in node['manifests'] if type(d) is dict and matches_platform(d.get('platform'),'arm64')]
            require(len(selected)==1,'arm64_manifest_missing' if not selected else 'arm64_manifest_ambiguous')
            child=selected[0];require(child.get('mediaType') in INDEX|IMAGE,'oci_child_media_type_required')
            digest=child.get('digest');expected_size=child.get('size')
            require(type(expected_size) is int and expected_size>=0,'oci_descriptor_size_required')
            continue
        require(node.get('mediaType') in IMAGE,'oci_image_manifest_required')
        config=node.get('config');require(type(config) is dict and config.get('mediaType') in CONFIG,'oci_config_required')
        require(type(config.get('size')) is int and config['size']>=0,'oci_descriptor_size_required')
        value=metadata.get(config.get('digest'),config['size'])
        require(matches_platform(value,'arm64'),'image_config_not_arm64')
        layers=node.get('layers');require(type(layers) is list,'oci_layers_required')
        for layer in layers:
            require(type(layer) is dict and isinstance(layer.get('digest'),str) and DIGEST.fullmatch(layer['digest']) and
                    type(layer.get('size')) is int and layer['size']>=0,'oci_layer_descriptor_required')
        return {'manifestDigest':digest,'configDigest':config['digest'],'layerCount':len(layers),
                'layerBytesVerified':False,'runtimeExecuted':False}
    raise ValueError('metadata_graph_depth_exceeded')


def tool_identity(path,expected):
    require(isinstance(expected,str) and re.fullmatch('[a-f0-9]{64}',expected),'trusted_tool_pin_required')
    require(path is not None,'tool_missing')
    require(Path(path).is_absolute(),'explicit_tool_path_required')
    path=regular(path,512*1024**2)
    try:return verify_executable(path,expected,'arm64')
    except ValueError:raise ValueError('tool_pin_or_architecture_mismatch') from None


def wheel_identity(row,directory):
    name=row.get('name');url=row.get('url');require(isinstance(name,str) and isinstance(url,str),'wheel_identity_required')
    filename=Path(urllib.parse.urlsplit(url).path).name
    pure=filename.endswith('-py3-none-any.whl')
    require(pure or ('-cp312-cp312-' in filename and 'aarch64' in filename and 'x86_64' not in filename),'wheel_not_arm64_cp312')
    require(directory is not None,'wheel_missing')
    path=regular(Path(directory)/filename,32*1024**2)
    require(path.stat().st_size==row.get('bytes'),'wheel_size_mismatch')
    require(hashlib.sha256(path.read_bytes()).hexdigest()==row.get('sha256'),'wheel_digest_mismatch')
    with zipfile.ZipFile(path) as archive:
        names=set();total=0;native_count=0
        for info in archive.infolist():
            parts=Path(info.filename)
            require(not parts.is_absolute() and '..' not in parts.parts and info.filename not in names,'unsafe_wheel_member')
            names.add(info.filename);total+=info.file_size
            require(total<=64*1024**2 and len(names)<=4096,'wheel_expansion_budget_exceeded')
            require((info.external_attr>>16)&0o170000 in (0,0o100000,0o040000),'unsafe_wheel_member')
            if info.is_dir():continue
            with archive.open(info) as stream:header=stream.read(20)
            if header.startswith(b'\x7fELF') or info.filename.endswith('.so'):
                native_count+=1
                require(not pure and info.file_size<=32*1024**2,'wheel_native_member_unexpected')
                require(len(header)==20 and header[:6]==b'\x7fELF\x02\x01' and int.from_bytes(header[18:20],'little')==183,'wheel_native_member_not_arm64')
        require(pure or native_count>0,'wheel_native_member_missing')
    return {'nativeImportExecuted':False,'platformIndependent':pure}


def audit(release,installer,tools=None,metadata_dir=None,wheel_dir=None,source_root=TASK):
    require(type(tools or {}) is dict and set(tools or {})<=set(TOOLS),'closed_tool_selection_required')
    checks=[]
    def check(role,callback):
        try:
            details=callback();checks.append({'role':role,'status':'identity_verified','details':details})
        except (ValueError,OSError,KeyError,TypeError,zipfile.BadZipFile,json.JSONDecodeError) as error:
            code=str(error) if type(error) is ValueError and re.fullmatch('[a-z0-9_]{1,100}',str(error)) else 'input_unavailable_or_invalid'
            checks.append({'role':role,'status':'blocked','code':code})
    check('catalog_platform',lambda: require(release.get('platform')=='linux-arm64','catalog_not_arm64'))
    check('installer_platform',lambda: require(Path(urllib.parse.urlsplit(installer['binary']['url']).path).name=='k3s-arm64' and
           installer['binary']['sha256']==release['installedTools']['k3s'],'installer_not_pinned_arm64'))
    for name in TOOLS:
        expected=(release.get('installedTools') or {}).get(name) if name in ('ops','bun','k3s') else ((release.get('tools') or {}).get('milvus' if name=='milvus-backup' else name) or {}).get('sha256')
        check('tool:'+name,lambda name=name,expected=expected:tool_identity((tools or {}).get(name),expected))
    metadata=LocalMetadata(metadata_dir)
    require(type(release.get('images')) is list and len(release['images'])<=128,'bounded_image_catalog_required')
    references=[r.get('reference') for r in release['images'] if type(r) is dict]
    require(len(references)==len(release['images']) and len(references)==len(set(references)),'unique_image_catalog_required')
    for index,row in enumerate(release['images']):check('image:'+str(index+1),lambda row=row:image_identity(row,metadata))
    for row in release.get('mongoWheels',[]):check('wheel:'+str(row.get('name')),lambda row=row:wheel_identity(row,wheel_dir))
    if source_root is not None:
        for name,needle in GUARDS.items():
            def source_check(name=name,needle=needle):
                raw=regular(Path(source_root)/name,1024**2).read_bytes()
                needles=(needle,) if isinstance(needle,str) else needle
                require(not any(value.encode() in raw for value in needles),'amd64_source_contract_present')
                return {'sha256':hashlib.sha256(raw).hexdigest(),'runtimeTested':False}
            check('source:'+name,source_check)
    blocked=sum(row['status']=='blocked' for row in checks)
    return {'schemaVersion':1,'requestedPlatform':'linux/arm64','auditKind':'offline_identity_only',
            'status':'blocked' if blocked else 'identity_checks_passed','migrationReady':False,
            'nativeRuntimeQualified':False,'metadataDocumentsRead':metadata.documents,'metadataBytesRead':metadata.bytes,
            'checks':checks,'summary':{'total':len(checks),'blocked':blocked,'identityVerified':len(checks)-blocked},
            'notExecuted':['download','tool_execution','layer_verification','migration','service_stop','restore','application_changes']}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog',type=Path,default=TASK/'migrate/releases/k3s-0.9.0.json')
    parser.add_argument('--installer',type=Path,default=TASK/'migrate/releases/local-k3s-installer.json')
    parser.add_argument('--metadata-dir',type=Path);parser.add_argument('--wheel-dir',type=Path)
    parser.add_argument('--tool',action='append',default=[],metavar='ROLE=PATH')
    args=parser.parse_args(argv);tools={}
    for binding in args.tool:
        name,sep,path=binding.partition('=');require(sep and name in TOOLS and name not in tools and Path(path).is_absolute(),'explicit_unique_tool_path_required');tools[name]=path
    result=audit(closed_json(regular(args.catalog,4*1024**2).read_bytes()),closed_json(regular(args.installer,1024**2).read_bytes()),tools,args.metadata_dir,args.wheel_dir)
    print(json.dumps(result,indent=2));return 2 if result['summary']['blocked'] else 0

if __name__=='__main__':sys.exit(main())
