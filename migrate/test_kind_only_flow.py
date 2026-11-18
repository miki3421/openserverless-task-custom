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

"""Full wrapper choreography against synthetic command executors only."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import stat
import unittest
from unittest.mock import patch,Mock

sys.path.insert(0,str(Path(__file__).resolve().parent))
import run
import target
import install
import source_runtime as S
from test_source_runtime import fixture,K,A,B,C

class KindOnlyFlow(unittest.TestCase):
    def exercise(self,fail_stop=False,drift=False,check=False,retry=False,plan_drift=False,durability_failure=False):
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory);(home/'tmp').mkdir();(home/'tmp/kubeconfig').write_text('synthetic source')
            root=home/'migrate';root.mkdir(mode=0o700)
            source,current,plan=fixture();source['cluster_uid']='synthetic-cluster'
            (root/'host-services.json').write_text(json.dumps(plan));(root/'host-services.json').chmod(0o600)
            bundle={'source':{'hostUuid':'synthetic-host','clusterUid':source['cluster_uid']},'runId':'b'*32,'docker':{'archiveCount':1,'sourceRecovered':True}}
            config={'sourceConfig':'/synthetic-source','host':{'uuid':'synthetic-host','address':'10.20.0.10'}}
            archive={'repository':'/synthetic-repository','passwordFile':'/synthetic-key','runId':'b'*32,'snapshot':'f'*64}
            request={'to':'k3s','check':check,'json':True,'repository':'','key':'','snapshot':'','ops':'synthetic-ops','bun':'synthetic-bun','bin':'/synthetic-bin','opsHome':str(home)}
            calls=[];installed=[]
            def check_output(args,**kw):
                calls.append(list(args))
                if args[0]=='git':return b''
                if args[0]=='ip':return b'[{"dev":"synthetic0"}]'
                self.assertEqual(args[:3],S.DOCKER)
                if 'info'in args:return b'synthetic-daemon\n'
                if 'ps'in args:return ('\n'.join(r['id'] for r in current['containers'])).encode()
                self.assertIn('inspect',args)
                return ('\n'.join(json.dumps(r) for r in current['containers'])).encode()
            def execute(args,stdout=None,stderr=None,**kw):
                calls.append(list(args));data=b''
                if args[:3]==S.DOCKER:
                    self.assertEqual(args[3:6],['stop','--time','300'])
                    proof=next(root.glob('run-*/source-runtime.private.json'))
                    self.assertTrue(json.loads(proof.read_text())['containers'][0]['wasRunning'])
                    if fail_stop and args[-1]==B:return Mock(returncode=1)
                    next(r for r in current['containers'] if r['id']==args[-1])['running']=False
                elif any(str(a).endswith('/migrate/install.py') for a in args) and args[-1]!='check':
                    value=json.loads(Path(args[-1]).read_text());installed.append(value['sourceRuntime'])
                    S.verify(value['sourceRuntime'])
                    if drift:current['containers'][0]['running']=True
                elif any(str(a).endswith('/migrate/prepare.py') for a in args):
                    target_home=home/'target';(target_home/'tmp').mkdir(parents=True)
                    (target_home/'tmp/kubeconfig').write_text('synthetic target')
                    profile=target_home/'restore.json';profile.write_text(json.dumps({'target':{'opsHome':str(target_home)}}))
                    (root/'prepared.json').write_text(json.dumps({'profile':str(profile)}))
                if stdout is None:return Mock(returncode=0,stdout=b'{}',stderr=b'')
                stdout.write(data);return Mock(returncode=0)
            def read(path,uid=None):
                if str(path)=='/synthetic-source':return {'kind':{'source':source}}
                return json.loads(Path(path).read_text())
            original=Path.read_text
            def release(path,*args,**kw):
                if path.name=='k3s-0.9.0.json':return json.dumps({'installedTools':{'ops':'qualified','bun':'qualified'},'images':[]})
                return original(path,*args,**kw)
            def download(*args,**kwargs):
                if plan_drift:(root/'host-services.json').write_text(json.dumps({'schemaVersion':1,'containers':[]}))
            real_fsync=os.fsync
            def fsync(fd):
                if durability_failure and stat.S_ISDIR(os.fstat(fd).st_mode):raise OSError('synthetic directory sync failure')
                real_fsync(fd)
            patches=[patch.object(run.os,'fsync',side_effect=fsync),patch.object(run.os,'getuid',return_value=1000),patch.object(run.sys,'version_info',(3,12)),
                patch.object(run,'verified_store',return_value=config),patch.object(run,'selected',return_value=(None,bundle)),
                patch.object(run,'acquire_operation',side_effect=lambda _:os.open(home/'lock',os.O_CREAT|os.O_RDWR,0o600)),
                patch.object(run,'hardware_uuid',return_value='synthetic-host'),patch.object(run,'read',side_effect=read),
                patch.object(run,'availability',return_value={'missing':[]}),patch.object(run,'acquisition_preflight'),
                patch.object(run,'check_remaining'),patch.object(run,'regular',side_effect=lambda p,*a:Path(p)),
                patch.object(run,'digest',return_value='qualified'),patch.object(run,'hydrate_native',return_value=archive),
                patch.object(run,'download',side_effect=download),patch.object(run,'await_nodes'),patch.object(run,'await_deployment'),
                patch.object(S,'local_socket'),patch.object(run.subprocess,'check_output',side_effect=check_output),
                patch.object(run.subprocess,'run',side_effect=execute),patch('kind_adapter.KindConfig'),patch('kind_adapter.cluster_identity'),
                patch.object(Path,'read_text',release),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO())]
            with contextlib.ExitStack() as stack:
                for item in patches:stack.enter_context(item)
                try:result=run.execute(request)
                except OSError:
                    if not durability_failure:raise
                    result=1
                if retry:
                    pointer=(root/'current.json').read_bytes();before=len(calls)
                    self.assertEqual(run.execute(request),1)
                    self.assertEqual((root/'current.json').read_bytes(),pointer)
                    self.assertEqual(len(calls),before)
            self.assertFalse(any('systemctl'in a or 'start'in a or 'disable'in a for a in calls))
            stop_ids=[a[-1] for a in calls if a[:3]==S.DOCKER and a[3]=='stop']
            if durability_failure:return result,stop_ids,calls,{},installed
            pointer=json.loads((root/'current.json').read_text());journal=root/('run-'+pointer['runId'])/'journal.json'
            state=json.loads(journal.read_text());return result,stop_ids,calls,state,installed
    def test_successful_full_flow_preserves_docker_and_never_restarts_containers(self):
        result,stops,calls,state,installed=self.exercise()
        self.assertEqual(result,0);self.assertEqual(stops,[A,B,K]);self.assertEqual(len(installed),1)
        self.assertTrue(state['dockerDaemonPreserved']);self.assertFalse(state['sourceDockerStoppedAndDisabled'])
        self.assertFalse(state['externalRestartAutomatic']);self.assertTrue(state['applicationAcceptanceRequired'])
        self.assertTrue(any(a[:2]==['synthetic-ops','restore'] for a in calls))
    def test_check_with_selected_external_services_has_no_effect(self):
        result,stops,calls,state,installed=self.exercise(check=True)
        self.assertEqual(result,0);self.assertEqual(stops,[]);self.assertEqual(installed,[])
        self.assertFalse(any(a[0]=='synthetic-ops' for a in calls));self.assertFalse(state['clusterMutation'])
    def test_partial_stop_failure_does_not_install_or_restore_or_retry(self):
        result,stops,calls,state,installed=self.exercise(fail_stop=True)
        self.assertEqual(result,1);self.assertEqual(stops,[A,B]);self.assertEqual(installed,[])
        self.assertFalse(any(a[0]=='synthetic-ops' for a in calls));self.assertEqual(state['phase'],'stop-source-containers')
    def test_source_restarted_after_install_blocks_restore(self):
        result,stops,calls,state,installed=self.exercise(drift=True)
        self.assertEqual(result,1);self.assertEqual(stops,[A,B,K]);self.assertEqual(len(installed),1)
        self.assertFalse(any(a[0]=='synthetic-ops' for a in calls))
    def test_directory_sync_failure_prevents_every_host_command(self):
        result,stops,calls,state,installed=self.exercise(durability_failure=True)
        self.assertEqual(result,1);self.assertEqual(stops,[]);self.assertEqual(installed,[])
        self.assertEqual(calls,[])

    def test_partial_stop_cannot_be_silently_resnapshotted_by_new_run(self):
        result,stops,calls,state,installed=self.exercise(fail_stop=True,retry=True)
        self.assertEqual(result,1);self.assertEqual(stops,[A,B]);self.assertEqual(installed,[])
    def test_stop_plan_changed_while_staging_blocks_first_stop(self):
        result,stops,calls,state,installed=self.exercise(plan_drift=True)
        self.assertEqual(result,1);self.assertEqual(stops,[]);self.assertEqual(installed,[])


class InstallerRuntimeProof(unittest.TestCase):
    def test_root_install_reobserves_source_before_copying_binary(self):
        source,current,plan=fixture();runtime=S.freeze(source,current,plan)
        for row in current['containers']:row['running']=False
        with tempfile.TemporaryDirectory() as directory:
            work=Path(directory);work.chmod(0o700)
            request={'uid':1000,'hostUuid':'synthetic-host','address':'10.20.0.10','interface':'synthetic0','work':str(work),'runId':'a'*32,'backupRunId':'b'*32,'sourceRuntime':runtime}
            original=Path.read_text
            def contents(path,*a,**kw):
                if str(path)=='/sys/class/dmi/id/product_uuid':return 'synthetic-host'
                return original(path,*a,**kw)
            def change():current['containers'][0]['running']=True
            with patch.object(install.os,'geteuid',return_value=0),patch.dict(os.environ,{'SUDO_UID':'1000'}),patch.object(install,'read',return_value=request),patch.object(Path,'read_text',contents),patch.object(install,'regular',side_effect=lambda p,*a:Path(p)),patch.object(install,'digest',return_value=json.loads((install.TASK/'migrate/releases/local-k3s-installer.json').read_text())['binary']['sha256']),patch.object(install,'MARKER',work/'marker'),patch.object(install,'fresh_target',side_effect=change),patch.object(S,'observe',side_effect=lambda execute=None:copy.deepcopy(current)),patch.object(install.subprocess,'check_output',return_value=b'[{"addr_info":[{"local":"10.20.0.10"}]}]'),patch.object(install.shutil,'copyfile') as copyfile,patch.object(install.subprocess,'run') as execute:
                # Both pinned files need their distinct published checksum.
                release=json.loads((install.TASK/'migrate/releases/local-k3s-installer.json').read_text())
                with patch.object(install,'digest',side_effect=lambda p:release['installer' if Path(p).name=='install.sh' else 'binary']['sha256']):
                    with self.assertRaisesRegex(ValueError,'state_changed'):install.install(work/'request')
                copyfile.assert_not_called();execute.assert_not_called()
    def test_target_proof_requires_valid_root_marker_and_exact_host_network(self):
        source,current,plan=fixture();runtime=S.freeze(source,current,plan)
        proof={'schemaVersion':2,'uid':1000,'hostUuid':'synthetic-host','address':'10.20.0.10','interface':'synthetic0','runId':'a'*32,'backupRunId':'b'*32,'sourceRuntime':runtime}
        observed={'address':'10.20.0.10','network':{'interface':'synthetic0'}}
        with patch.object(Path,'exists',return_value=True),patch.object(target,'private_json',return_value=proof) as read:
            self.assertEqual(target.installation_runtime(observed,'synthetic-host'),runtime)
            read.assert_called_with(Path('/etc/ops-migrate-install.private.json'),0)
            for mutate in [lambda p:p.update(schemaVersion=True),lambda p:p.update(hostUuid='foreign'),lambda p:p.update(address='10.20.0.11'),lambda p:p.update(sourceRuntime=None),lambda p:p.pop('sourceRuntime')]:
                bad=copy.deepcopy(proof);mutate(bad)
                with patch.object(target,'private_json',return_value=bad),self.assertRaises(ValueError):target.installation_runtime(observed,'synthetic-host')

if __name__=='__main__':unittest.main()
