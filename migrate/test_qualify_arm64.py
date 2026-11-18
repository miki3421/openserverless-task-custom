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

"""Synthetic offline identity qualification; no executable or provider calls."""
import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.request
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parent))
import qualify_arm64 as Q


def elf(machine=183):
    data=bytearray(64);data[:6]=b'\x7fELF\x02\x01';data[18:20]=machine.to_bytes(2,'little');return bytes(data)

def blob(root,value):
    raw=json.dumps(value,sort_keys=True).encode();digest='sha256:'+hashlib.sha256(raw).hexdigest()
    directory=root/'blobs/sha256';directory.mkdir(parents=True,exist_ok=True);(directory/digest[7:]).write_bytes(raw)
    return {'digest':digest,'size':len(raw)}

def image(root,arch='arm64',label='arm64',variant='v8',duplicates=False):
    cfg=blob(root,{'os':'linux','architecture':arch})
    manifest=blob(root,{'schemaVersion':2,'mediaType':sorted(Q.IMAGE)[0],
        'config':{**cfg,'mediaType':sorted(Q.CONFIG)[0]},'layers':[]})
    child={**manifest,'mediaType':sorted(Q.IMAGE)[0],'platform':{'os':'linux','architecture':label,'variant':variant}}
    index=blob(root,{'schemaVersion':2,'mediaType':sorted(Q.INDEX)[0],'manifests':[child]*(2 if duplicates else 1)})
    return {'reference':'registry.example/synthetic:1','digest':index['digest']},cfg,manifest

def fixture(root):
    tools={};pins={};more={}
    for name in Q.TOOLS:
        path=root/name;path.write_bytes(elf());tools[name]=path
        if name in ('ops','bun','k3s'):pins[name]=hashlib.sha256(path.read_bytes()).hexdigest()
        else:more['milvus' if name=='milvus-backup' else name]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    return {'platform':'linux-arm64','installedTools':pins,'tools':more,'images':[],'mongoWheels':[]}, {'binary':{'url':'https://example.invalid/k3s-arm64','sha256':pins['k3s']}},tools

class OfflineArm64Audit(unittest.TestCase):
    def test_all_identity_checks_never_claim_operational_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);release,installer,tools=fixture(root);r,_,_=image(root);release['images']=[r]
            result=Q.audit(release,installer,tools,root,source_root=None)
            self.assertEqual(result['status'],'identity_checks_passed');self.assertFalse(result['migrationReady'])
            self.assertFalse(result['nativeRuntimeQualified']);self.assertEqual(result['metadataDocumentsRead'],3)
            self.assertFalse(result['checks'][-1]['details']['layerBytesVerified'])
    def test_local_arm64_elf_is_not_a_trusted_catalog_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            release,installer,tools=fixture(Path(directory));release['installedTools']['ops']='a'*64
            result=Q.audit(release,installer,tools,source_root=None)
            row=next(r for r in result['checks'] if r['role']=='tool:ops')
            self.assertEqual(row['code'],'tool_pin_or_architecture_mismatch')
    def test_trusted_amd64_binary_is_not_arm64(self):
        with tempfile.TemporaryDirectory() as directory:
            release,installer,tools=fixture(Path(directory));tools['ops'].write_bytes(elf(62));release['installedTools']['ops']=hashlib.sha256(elf(62)).hexdigest()
            result=Q.audit(release,installer,tools,source_root=None)
            self.assertEqual(next(r for r in result['checks'] if r['role']=='tool:ops')['status'],'blocked')
    def test_missing_tool_is_blocked_with_no_path_search(self):
        with tempfile.TemporaryDirectory() as directory:
            release,installer,tools=fixture(Path(directory));tools.pop('bun')
            with patch('shutil.which',side_effect=AssertionError('PATH search')):
                result=Q.audit(release,installer,tools,source_root=None)
            self.assertEqual(next(r for r in result['checks'] if r['role']=='tool:bun')['code'],'tool_missing')
    def test_catalog_and_installer_keep_original_amd64_blockers(self):
        with tempfile.TemporaryDirectory() as directory:
            release,installer,tools=fixture(Path(directory));release['platform']='linux-amd64';installer['binary']['url']='https://example.invalid/k3s'
            result=Q.audit(release,installer,tools,source_root=None)
            self.assertEqual([r['status'] for r in result['checks'][:2]],['blocked','blocked'])
    def test_index_label_cannot_hide_foreign_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);row,_,_=image(root,arch='amd64')
            with self.assertRaisesRegex(ValueError,'image_config_not_arm64'):Q.image_identity(row,Q.LocalMetadata(root))
    def test_bad_variant_and_duplicate_arm_children_are_blocked(self):
        for variant,duplicates,code in [('v9',False,'missing'),('v8',True,'ambiguous')]:
            with self.subTest(variant=variant),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);row,_,_=image(root,variant=variant,duplicates=duplicates)
                with self.assertRaisesRegex(ValueError,code):Q.image_identity(row,Q.LocalMetadata(root))
    def test_absent_root_child_or_config_never_fetches(self):
        for missing in ['root','child','config']:
            with self.subTest(missing=missing),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);row,cfg,child=image(root)
                digest=row['digest'] if missing=='root' else child['digest'] if missing=='child' else cfg['digest']
                (root/'blobs/sha256'/digest[7:]).unlink()
                with patch.object(urllib.request,'urlopen',side_effect=AssertionError('network')):
                    with self.assertRaisesRegex(ValueError,'metadata_missing'):Q.image_identity(row,Q.LocalMetadata(root))
    def test_corrupt_digest_and_symlink_input_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);row,cfg,_=image(root);path=root/'blobs/sha256'/cfg['digest'][7:];path.write_text('{}')
            with self.assertRaisesRegex(ValueError,'digest_mismatch'):Q.image_identity(row,Q.LocalMetadata(root))
            target=root/'copy';path.rename(target);path.symlink_to(target)
            with self.assertRaisesRegex(ValueError,'linked_input'):Q.image_identity(row,Q.LocalMetadata(root))
    def test_descriptor_size_is_verified_against_original_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);_,_,child=image(root)
            with self.assertRaisesRegex(ValueError,'size_mismatch'):Q.LocalMetadata(root).get(child['digest'],child['size']+1)
    def test_duplicate_json_and_duplicate_image_roles_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'duplicate_metadata'):Q.closed_json(b'{"architecture":"arm64","architecture":"amd64"}')
        with tempfile.TemporaryDirectory() as directory:
            release,installer,tools=fixture(Path(directory));row={'reference':'registry.example/synthetic:1','digest':'sha256:'+'a'*64};release['images']=[row,row]
            with self.assertRaisesRegex(ValueError,'unique_image_catalog'):Q.audit(release,installer,tools,source_root=None)
    def test_unknown_tool_role_and_unpinned_tool_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            release,installer,tools=fixture(Path(directory));tools['shell']='/bin/sh'
            with self.assertRaisesRegex(ValueError,'closed_tool_selection'):Q.audit(release,installer,tools,source_root=None)
    def test_wheel_architecture_name_and_payload_both_must_match(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);filename='pymongo-4.18.2-cp312-cp312-manylinux2014_aarch64.whl';path=root/filename
            for machine,passed in [(62,False),(183,True)]:
                with zipfile.ZipFile(path,'w') as archive:archive.writestr('bson/_cbson.so',elf(machine))
                row={'name':'pymongo','url':'https://example.invalid/'+filename,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size}
                if passed:self.assertFalse(Q.wheel_identity(row,root)['nativeImportExecuted'])
                else:
                    with self.assertRaisesRegex(ValueError,'native_member_not_arm64'):Q.wheel_identity(row,root)
            row['url']=row['url'].replace('aarch64','x86_64')
            with self.assertRaisesRegex(ValueError,'wheel_not_arm64'):Q.wheel_identity(row,root)
    def test_source_architecture_blocker_is_recorded_without_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);release,installer,tools=fixture(root);p=root/'migrate/target.py';p.parent.mkdir();p.write_text("machine == 'x86_64'")
            original=p.read_bytes();result=Q.audit(release,installer,tools,source_root=root)
            row=next(r for r in result['checks'] if r['role']=='source:migrate/target.py')
            self.assertEqual(row['code'],'amd64_source_contract_present');self.assertEqual(p.read_bytes(),original)
    def test_audit_never_executes_tools_or_contacts_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            release,installer,tools=fixture(Path(directory))
            with patch.object(subprocess,'run',side_effect=AssertionError('execution')),patch.object(subprocess,'check_output',side_effect=AssertionError('execution')),patch.object(urllib.request,'urlopen',side_effect=AssertionError('network')):
                self.assertEqual(Q.audit(release,installer,tools,source_root=None)['summary']['blocked'],0)

if __name__=='__main__':unittest.main()
