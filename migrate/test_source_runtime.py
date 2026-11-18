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

"""Synthetic native-command boundaries. No Docker, OPS or host service calls."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'restore'))
import source_runtime as S
import same_host
import run
import tempfile
import os
import stat
from test_same_host import selected,marker,controllers

K='a'*64; A='b'*64; B='c'*64; C='d'*64

def row(ident,running=True,kind=None):
    return {'id':ident,'image':'sha256:'+'e'*64,'running':running,'paused':False,
            'restarting':False,'restartPolicy':'unless-stopped','kindCluster':kind}

def fixture():
    source={'container_id':K,'docker_context':'default','docker_daemon_id':'synthetic-daemon','kind_cluster':'synthetic-kind'}
    observed={'daemonId':'synthetic-daemon','containers':[row(K,kind='synthetic-kind'),row(A),row(B),row(C,False)]}
    plan={'schemaVersion':1,'containers':[{'id':A,'disposition':'retain-docker'},{'id':B,'disposition':'move-to-k3s'}]}
    return source,observed,plan

class RuntimeBoundaries(unittest.TestCase):
    def runtime(self):return S.freeze(*fixture())
    def test_local_socket_and_sanitized_environment_are_explicit(self):
        calls=[]
        with patch.object(S,'local_socket') as sock:
            S.native_command(S.DOCKER+['info'],lambda args,**kw:calls.append((args,kw)) or b'ok')
        sock.assert_called_once();self.assertEqual(calls[0][0][:3],S.DOCKER)
        self.assertEqual(set(calls[0][1]['env']),{'PATH','HOME','LANG'})
    def test_native_observation_uses_only_noncontent_format(self):
        _,observed,_=fixture();calls=[]
        def execute(args,**kw):
            calls.append(args)
            if 'info'in args:return b'synthetic-daemon\n'
            if 'ps'in args:return ('\n'.join(r['id'] for r in observed['containers'])).encode()
            self.assertEqual(args[3:6],['inspect','--format',S.FORMAT])
            return ('\n'.join(json.dumps(r) for r in observed['containers'])).encode()
        with patch.object(S,'local_socket'):
            self.assertEqual(S.observe(execute)['daemonId'],'synthetic-daemon')
        self.assertEqual(len(calls),3);self.assertNotIn('Env',S.FORMAT)
    def test_selection_order_original_state_and_restart_proposal(self):
        runtime=self.runtime();self.assertEqual([r['id'] for r in runtime['containers']],[A,B,C,K])
        self.assertFalse(runtime['containers'][2]['wasRunning'])
        self.assertEqual(S.restart_candidates(runtime),[A])
    def test_active_unselected_and_another_kind_are_rejected(self):
        source,observed,plan=fixture();plan['containers']=[]
        with self.assertRaisesRegex(ValueError,'foreign_running'):S.freeze(source,observed,plan)
        source,observed,plan=fixture();observed['containers'][1]['kindCluster']='another-kind'
        with self.assertRaisesRegex(ValueError,'additional_kind'):S.freeze(source,observed,plan)
    def test_missing_duplicate_source_and_unknown_selection_rejected(self):
        source,observed,plan=fixture()
        for rows in [[{'id':'f'*64,'disposition':'retain-docker'}],[{'id':K,'disposition':'retain-docker'}],plan['containers']*2,[{'id':A,'disposition':'unknown'}]]:
            with self.subTest(rows=len(rows)),self.assertRaises(ValueError):S.freeze(source,observed,{'schemaVersion':1,'containers':rows})
    def test_remote_context_daemon_and_kind_label_drift_rejected(self):
        for key,value in [('docker_context','remote'),('docker_daemon_id','foreign'),('kind_cluster','wrong')]:
            source,observed,plan=fixture();source[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):S.freeze(source,observed,plan)
    def test_keep_stopped_never_stops_an_active_container(self):
        source,observed,plan=fixture();plan['containers'][0]['disposition']='keep-stopped'
        with self.assertRaisesRegex(ValueError,'keep_stopped'):S.freeze(source,observed,plan)
    def test_closed_types_and_nonmutable_identity_are_required(self):
        runtime=self.runtime()
        for mutate in [lambda r:r.update(schemaVersion=True),lambda r:r.update(extra=1),lambda r:r['containers'][0].update(wasRunning=1),lambda r:r['containers'][0].update(image='image:latest'),lambda r:r['containers'].append(r['containers'][0])]:
            bad=copy.deepcopy(runtime);mutate(bad)
            with self.assertRaises(ValueError):S.validate_runtime(bad)
    def test_stop_order_kind_last_and_no_start_or_daemon_operation(self):
        source,current,plan=fixture();runtime=S.freeze(source,current,plan);calls=[];proof=[]
        def execute(args):
            self.assertTrue(proof);calls.append(args)
            next(r for r in current['containers'] if r['id']==args[-1])['running']=False
        with patch.object(S,'observe',side_effect=lambda execute=None:copy.deepcopy(current)):
            S.stop_selected(runtime,execute,lambda value:proof.append(copy.deepcopy(value)))
        self.assertEqual([args[-1] for args in calls],[A,B,K])
        self.assertTrue(all(args[3:6]==['stop','--time','300'] for args in calls))
        self.assertIsNone(proof[-1]['nextContainerId'])
    def test_stop_failure_is_not_retried_and_no_restart_occurs(self):
        _,current,_=fixture();runtime=self.runtime();calls=[]
        def execute(args):
            calls.append(args)
            if args[-1]==B:raise subprocess.CalledProcessError(1,args)
            next(r for r in current['containers'] if r['id']==args[-1])['running']=False
        with patch.object(S,'observe',side_effect=lambda execute=None:copy.deepcopy(current)):
            with self.assertRaises(subprocess.CalledProcessError):S.stop_selected(runtime,execute,lambda _:None)
        self.assertEqual([a[-1] for a in calls],[A,B])
    def test_drift_before_stop_has_no_effect(self):
        _,observed,_=fixture();observed['containers'][1]['image']='sha256:'+'f'*64
        with patch.object(S,'observe',return_value=observed):
            with self.assertRaisesRegex(ValueError,'identity_changed'):
                S.stop_selected(self.runtime(),lambda args:self.fail('unexpected stop'),lambda _:None)
    def test_restarted_missing_new_image_policy_and_daemon_changes_deny(self):
        for mutation in ('running','missing','new','image','policy','daemon'):
            _,observed,_=fixture()
            for r in observed['containers']:r['running']=False
            if mutation=='running':observed['containers'][0]['running']=True
            elif mutation=='missing':observed['containers'].pop()
            elif mutation=='new':observed['containers'].append(row('f'*64,False))
            elif mutation=='image':observed['containers'][0]['image']='sha256:'+'f'*64
            elif mutation=='policy':observed['containers'][0]['restartPolicy']='always'
            else:observed['daemonId']='foreign'
            with self.subTest(mutation=mutation),patch.object(S,'observe',return_value=observed),self.assertRaises(ValueError):S.verify(self.runtime())
    def test_marker_v2_binds_runtime_to_original_source(self):
        p=selected();m=marker(p,controllers());runtime=self.runtime()
        runtime['kindContainerId']=p['source']['kindContainerId'];runtime['containers'][-1]['id']=p['source']['kindContainerId']
        m.update(schemaVersion=2,sourceRuntime=runtime);same_host.validate_marker(p,m)
        m['sourceRuntime']=self.runtime()
        with self.assertRaisesRegex(ValueError,'source_runtime_mismatch'):same_host.validate_marker(p,m)
    def test_marker_v2_cannot_fall_back_on_missing_or_malformed_proof(self):
        p=selected();m=marker(p,controllers());m['schemaVersion']=2
        with self.assertRaises(ValueError):same_host.validate_marker(p,m)
        m['sourceRuntime']=None
        with self.assertRaises(ValueError):same_host.validate_marker(p,m)
        m['schemaVersion']=1
        with self.assertRaises(ValueError):same_host.validate_marker(p,m)
    def test_evidence_file_and_both_directory_entries_are_synced_before_return(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);work=root/'run-synthetic';work.mkdir()
            target=work/'source-runtime.private.json';events=[]
            fsync=os.fsync;replace=os.replace
            def sync(fd):
                info=os.fstat(fd);events.append(('dir' if stat.S_ISDIR(info.st_mode) else 'file',info.st_ino));fsync(fd)
            def rename(source,dest):events.append(('replace',0));replace(source,dest)
            with patch.object(run.os,'fsync',side_effect=sync),patch.object(run.os,'replace',side_effect=rename):
                run.durable_save(target,{'sourceStopStarted':True})
            self.assertEqual([e[0] for e in events],['file','replace','dir','dir'])
            self.assertEqual([e[1] for e in events[-2:]],[work.stat().st_ino,root.stat().st_ino])
            self.assertEqual(target.stat().st_mode&0o777,0o600)

    def test_prior_partial_stop_requires_review_without_replacing_pointer(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);prior=root/('run-'+'f'*32);prior.mkdir()
            (root/'current.json').write_text(json.dumps({'runId':'f'*32}));(root/'current.json').chmod(0o600)
            (prior/'journal.json').write_text(json.dumps({'sourceStopStarted':True,'status':'failed'}));(prior/'journal.json').chmod(0o600)
            original=(root/'current.json').read_bytes()
            with self.assertRaisesRegex(ValueError,'previous_source_stop'):run.previous_stop_requires_review(root,os.getuid())
            self.assertEqual((root/'current.json').read_bytes(),original)
            (root/'prepared.json').write_text('{}')
            # Only admission is allowed here. Existing target/backup/runtime and
            # no-restore-checkpoint validation still occurs in the actual wrapper.
            run.previous_stop_requires_review(root,os.getuid())

    def test_new_guard_does_not_select_legacy_daemon_off_path(self):
        with patch.object(S,'verify',return_value=True) as verify,patch.object(same_host.subprocess,'run',side_effect=AssertionError('legacy guard called')):
            same_host.source_offline(runtime=self.runtime());verify.assert_called_once()

if __name__=='__main__':unittest.main()
