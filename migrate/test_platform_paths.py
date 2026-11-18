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

"""Explicit architecture preparation; all command executors are synthetic."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

TASK=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(TASK/'restore'));sys.path.insert(0,str(TASK/'migrate'))
import acquisition
import assets
import source_cache
from platform_contract import architecture,binary_directory,elf_identity,profile_platform,release_platform
from test_source_cache import fixture as source_fixture
from test_acquisition import fixture as image_fixture
from test_native_artifacts import elf


class PlatformPaths(unittest.TestCase):
    def test_profile_v1_never_inherits_current_host_or_target_override(self):
        profile={'schemaVersion':1,'target':{}}
        self.assertEqual(profile_platform(profile),'linux/amd64')
        for wrong in ({**profile,'schemaVersion':True},{**profile,'schemaVersion':2},{**profile,'platform':'linux/arm64'},
                      {**profile,'target':{'platform':'linux/arm64'}}):
            with self.assertRaises(ValueError):profile_platform(wrong)

    def test_closed_platforms_select_native_directory_and_elf(self):
        for selected,machine,arch in [('linux/amd64',62,'amd64'),('linux/arm64',183,'arm64')]:
            self.assertEqual(architecture(selected),arch)
            self.assertEqual(binary_directory(selected),'.ops/linux-'+arch+'/bin')
            self.assertTrue(elf_identity(elf(machine),selected))
            self.assertFalse(elf_identity(elf(183 if machine==62 else 62),selected))
            self.assertFalse(elf_identity(elf(machine)[:5]+b'\x02'+elf(machine)[6:],selected))
        for invalid in (None,'aarch64','linux/arm64/v8','linux-arm64','linux/ARM64','../../arm64',[]):
            with self.assertRaises(ValueError):architecture(invalid)

    def test_release_absence_is_legacy_amd64_and_unknown_never_falls_back(self):
        self.assertEqual(release_platform({}),'linux/amd64')
        self.assertEqual(release_platform({'platform':'linux-arm64'}),'linux/arm64')
        for value in (None,'linux/arm64','linux-armv7',[]):
            with self.assertRaises(ValueError):release_platform({'platform':value})

    def test_preflight_passes_selected_architecture_and_freezes_platform(self):
        images,document,plan=image_fixture()
        with tempfile.TemporaryDirectory() as temp,             mock.patch.object(acquisition,'acquisition_plan',wraps=acquisition.acquisition_plan) as planner,             mock.patch.object(acquisition,'filesystem_check',return_value={'capacityBytes':160*acquisition.GIB,'availableBytes':120*acquisition.GIB,'filesystem':{}}):
            result=acquisition.preflight(images,temp,mock.Mock(),target_ready=False,fetch=lambda *a:document,platform='linux/arm64')
            self.assertEqual(planner.call_args.kwargs['architecture'],'arm64')
            self.assertEqual(result['platform'],'linux/arm64')
            self.assertEqual(json.loads((Path(temp)/'image-acquisition-plan.json').read_text())['platform'],'linux/arm64')

    def test_expansion_checks_selected_arm64_in_original_archives(self):
        _,_,plan=image_fixture();plan['platform']='linux/arm64'
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/'synthetic.tar';file.write_bytes(b'not actually imported')
            with mock.patch.object(acquisition,'image_storage',return_value={'contentStoreUpperBoundBytes':0,'imageImportAllowanceBytes':0}) as storage,                 mock.patch.object(acquisition,'filesystem_check',return_value={'availableBytes':120*acquisition.GIB}):
                acquisition.check_expansion(plan,[file],temp,mock.Mock())
                self.assertEqual(storage.call_args.kwargs['architecture'],'arm64')

    def test_invalid_platform_prevents_capacity_or_fetch(self):
        inspect=mock.Mock();run=mock.Mock()
        with mock.patch.object(acquisition,'filesystem_check',inspect):
            with self.assertRaises(ValueError):acquisition.preflight([],None,run,platform='linux/armv7')
            with self.assertRaises(ValueError):acquisition.check_remaining({'platform':'wrong'},None,run)
        inspect.assert_not_called();run.assert_not_called()

    def test_original_source_fetch_uses_source_platform_not_target_or_host(self):
        ref='registry.example/original:legacy'
        plan={'platform':'linux/arm64','workingBytes':100,'perImageContentUpperBoundBytes':{ref:30}}
        with tempfile.TemporaryDirectory() as temp,mock.patch.object(source_cache,'preflight',return_value=plan) as preflight,             mock.patch.object(source_cache,'check_remaining'):
            run=mock.Mock();source_cache.recover_missing(source_fixture(),temp,run,1,platform='linux/arm64')
            self.assertEqual(preflight.call_args.kwargs['platform'],'linux/arm64')
            command=run.call_args.args[1];self.assertIn('linux/arm64',command)
            self.assertEqual(command[-1],'registry.example/original@sha256:'+'c'*64)
            self.assertFalse(any(x in command for x in ('pull','import','unpack')))

    def test_source_plan_disagreement_prevents_provider_fetch(self):
        with tempfile.TemporaryDirectory() as temp,mock.patch.object(source_cache,'preflight',return_value={'platform':'linux/amd64'}):
            run=mock.Mock()
            with self.assertRaisesRegex(ValueError,'platform_mismatch'):
                source_cache.recover_missing(source_fixture(),temp,run,1,platform='linux/arm64')
            run.assert_not_called()

    def test_target_export_fetch_and_expansion_share_one_platform(self):
        images,_,plan=image_fixture();plan['platform']='linux/arm64';calls=[]
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for name in ('tools','clients','tasks','downloads','images'):(root/name).mkdir()
            def run(label,args,**kwargs):
                calls.append(args)
                if label.startswith('image-list'):return ('REF TYPE DIGEST\n'+images[0]['reference']+' OCI '+images[0]['digest']+'\n').encode()
                if label.startswith('export-'):Path(args[args.index('linux/arm64')+1]).write_bytes(b'synthetic')
                return b''
            release={'platform':'linux-arm64','images':images,'target':{'images':{'operator':images[0]['reference']}}}
            with mock.patch.object(assets,'check_remaining'),mock.patch.object(assets,'check_expansion') as expand,                 mock.patch.object(assets.image_namespace,'create',return_value={'namespace':'synthetic'}),mock.patch.object(assets.image_namespace,'release'):
                assets.acquire_images(release,root,run,mock.Mock(),plan)
                self.assertEqual(expand.call_args.args[0]['platform'],'linux/arm64')
            self.assertEqual(len([a for a in calls if '--platform' in a]),3)
            self.assertTrue(all(a[a.index('--platform')+1]=='linux/arm64' for a in calls if '--platform' in a))
            self.assertFalse(any('pull' in a or 'unpack' in a for a in calls))

    def test_catalog_plan_mismatch_prevents_namespace_creation(self):
        with mock.patch.object(assets.image_namespace,'create') as create:
            with self.assertRaisesRegex(ValueError,'platform_mismatch'):
                assets.acquire_images({'platform':'linux-arm64'},'/absent',mock.Mock(),mock.Mock(),{})
            create.assert_not_called()

    def test_real_oci_archive_expansion_uses_arm64_and_rejects_amd64(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location('synthetic_image_archive',TASK/'restore/test_image_storage.py')
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);graph=helper.graph(architecture='arm64');archive,_=helper.archive(root,[graph])
            plan={'platform':'linux/arm64','contentUpperBoundBytes':1024**3,'filesystem':{},'reserveBytes':0}
            with mock.patch.object(acquisition,'filesystem_check',return_value={'availableBytes':120*acquisition.GIB}):
                result=acquisition.check_expansion(plan,[archive],root,mock.Mock())
                self.assertEqual(result['imageRoots'],1)
                self.assertGreater(result['imageImportAllowanceBytes'],0)
                plan['platform']='linux/amd64'
                with self.assertRaises(ValueError):acquisition.check_expansion(plan,[archive],root,mock.Mock())

    def test_current_operational_profile_gate_remains_closed_to_arm(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location('synthetic_restore_contract',TASK/'restore/test_contract.py')
        contract=importlib.util.module_from_spec(spec);spec.loader.exec_module(contract)
        profile=contract.profile();profile['schemaVersion']=2;profile['target']['platform']='linux/arm64'
        with self.assertRaises(ValueError):contract.validate_profile(profile)


if __name__=='__main__':unittest.main()
