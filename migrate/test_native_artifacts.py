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

"""Synthetic byte-only native staging. Never executes a staged binary."""
import bz2
import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parent))
import stage_native_artifacts as native


def elf(machine=183):
    raw=bytearray(64);raw[:6]=b'\x7fELF\x02\x01';raw[18:20]=machine.to_bytes(2,'little')
    return bytes(raw)


def fixture(root):
    source=root/'inputs';source.mkdir();rows=[]
    for role,format,filename in [('k3s','elf','k3s-arm64'),('restic','bz2-elf','restic.bz2'),('milvus-backup','tar-gz-elf','milvus.tar.gz'),
                                 ('pymongo','wheel','pymongo-1-cp312-cp312-manylinux2014_aarch64.whl'),('dnspython','wheel','dnspython-1-py3-none-any.whl')]:
        path=source/filename
        if format=='elf':path.write_bytes(elf())
        elif format=='bz2-elf':path.write_bytes(bz2.compress(elf()))
        elif format=='tar-gz-elf':
            with tarfile.open(path,'w:gz') as archive:
                member=tarfile.TarInfo('bin/milvus-backup');member.size=len(elf());archive.addfile(member,io.BytesIO(elf()))
        else:
            with zipfile.ZipFile(path,'w') as archive:archive.writestr('bson/native.so' if role=='pymongo' else 'dns/__init__.py',elf() if role=='pymongo' else b'# synthetic')
        rows.append({'role':role,'format':format,'url':'https://example.invalid/'+filename,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size})
    return {'schemaVersion':1,'kind':'offline-native-artifact-inputs','platform':'linux/arm64','operationallyQualified':False,'artifacts':rows},source


class NativeStaging(unittest.TestCase):
    def test_all_five_original_inputs_have_exact_offline_proofs(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest,source=fixture(root)
            result=native.stage(manifest,source,root/'verified')
            self.assertEqual(len(result['artifacts']),5)
            self.assertFalse(result['migrationReady']);self.assertFalse(result['installed'])
            for tool in (root/'verified/tools').iterdir():
                self.assertEqual(tool.stat().st_mode&0o777,0o600)
                self.assertEqual(tool.read_bytes(),elf())
            self.assertTrue((root/'verified/receipt.json').is_file())

    def test_hash_failure_does_not_create_stage_or_publish_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest,source=fixture(root);manifest['artifacts'][-1]['sha256']='0'*64
            with self.assertRaisesRegex(ValueError,'digest'):native.stage(manifest,source,root/'verified')
            self.assertFalse((root/'verified').exists())

    def test_wrong_native_architecture_and_endianness_reject(self):
        for raw in (elf(62),elf()[:5]+b'\x02'+elf()[6:],b'not an executable'):
            with self.subTest(raw=raw),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);manifest,source=fixture(root);path=source/'k3s-arm64';path.write_bytes(raw)
                manifest['artifacts'][0].update(sha256=hashlib.sha256(raw).hexdigest(),bytes=len(raw))
                with self.assertRaisesRegex(ValueError,'tool_pin_or_architecture'):native.stage(manifest,source,root/'verified')
                self.assertFalse((root/'verified/receipt.json').exists())

    def test_archive_symlink_duplicate_and_traversal_reject(self):
        for name,kind in [('../milvus-backup','file'),('symlink','link'),('milvus-backup','duplicate')]:
            with self.subTest(name=name,kind=kind),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);archive=root/'archive.tar.gz'
                with tarfile.open(archive,'w:gz') as out:
                    member=tarfile.TarInfo(name)
                    if kind=='link':member.type=tarfile.SYMTYPE;member.linkname='/outside';out.addfile(member)
                    else:
                        member.size=64;out.addfile(member,io.BytesIO(elf()))
                        if kind=='duplicate':out.addfile(member,io.BytesIO(elf()))
                with self.assertRaises(ValueError):native.unpack_binary(archive,root/'tool','tar-gz-elf')
                self.assertFalse((root/'outside').exists())

    def test_expansion_bound_is_enforced_before_over_limit_write(self):
        with tempfile.TemporaryDirectory() as temp:
            target=Path(temp)/'output'
            with self.assertRaisesRegex(ValueError,'expansion_budget'):native.bounded_copy(io.BytesIO(b'a'*65),target,64)
            self.assertLessEqual(target.stat().st_size,64)

    def test_existing_linked_destination_or_input_reject(self):
        for linked in (False,True):
            with tempfile.TemporaryDirectory() as temp:
                root=Path(temp);manifest,source=fixture(root)
                if linked:
                    (source/'other').write_bytes(elf());(source/'k3s-arm64').unlink();(source/'k3s-arm64').symlink_to(source/'other')
                else:(root/'verified').mkdir()
                with self.assertRaises(ValueError):native.stage(manifest,source,root/'verified')

    def test_closed_manifest_rejects_added_roles_or_operational_claims(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest,source=fixture(root)
            for mutate in (lambda m:m.update(operationallyQualified=True),lambda m:m['artifacts'].append(copy.deepcopy(m['artifacts'][0])),lambda m:m.update(download=True)):
                wrong=copy.deepcopy(manifest);mutate(wrong)
                with self.assertRaises(ValueError):native.stage(wrong,source,root/'verified')


if __name__=='__main__':unittest.main()
