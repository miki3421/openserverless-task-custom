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

"""Single-host rehearsal: selected host-store kind backup to pinned K3s 0.9."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback
import uuid

TASK=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(TASK/'backup/engine/scripts'))
from store_common import require,read,save,digest,regular,hardware_uuid,acquire_operation
from store_driver import verified_store,selected,hydrate_native
from store_remote import RemoteRestic
from assets import download
from images import availability
from acquisition import preflight as acquisition_preflight,check_remaining
sys.path.insert(0,str(TASK/'restore'))
import source_runtime

from platform_contract import release_platform
from runtime_inventory import prepared_selection, read_runtime_selection, selected_release, stream_process

def durable_save(path, value):
    """Persist new migration evidence and its newly created run-directory entry.

    Keep the shared legacy store helper unchanged. It fsyncs the replacement
    file; this scope additionally fsyncs the rename parent and its parent before
    any stop can proceed. Journal/current writes cover run and migrate creation.
    """
    save(path, value)
    parent=Path(path).parent
    for directory in (parent,parent.parent):
        descriptor=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:os.fsync(descriptor)
        finally:os.close(descriptor)


def await_resource(k,args,predicate,work,label,timeout):
    """Wait for creation as well as readiness during asynchronous bootstrap."""
    deadline=time.monotonic()+timeout;last={}
    while time.monotonic()<deadline:
        try:p=subprocess.run([*k,*args,'-o','json','--request-timeout=5s'],capture_output=True,timeout=15)
        except subprocess.TimeoutExpired:
            last={'error':'metadata_request_timeout'};time.sleep(2);continue
        if p.returncode==0:
            try:
                value=json.loads(p.stdout)
                if predicate(value):return
            except ValueError:pass
        last={'stdout':p.stdout.decode(errors='replace'),'stderr':p.stderr.decode(errors='replace')};time.sleep(2)
    durable_save(Path(work)/(label+'-failure.private.json'),last);raise ValueError('target_'+label.replace('-','_')+'_timeout')

def await_nodes(k,work,timeout=240):
    await_resource(k,['get','nodes'],lambda v:len(v.get('items',[]))==1,work,'node-registration',timeout)

def await_deployment(k,namespace,name,work,timeout=300):
    await_resource(k,['get','deployment',name,'-n',namespace,'--ignore-not-found'],lambda v:v.get('kind')=='Deployment',work,'deployment-'+namespace+'-'+name,timeout)

def resume_binding(pointer,p,bundle,c):
    require(pointer['snapshot']==p['archive']['snapshot']==bundle['native']['snapshot'] and
            pointer['targetClusterUid']==p['target']['clusterUid'] and
            p['source']['clusterUid']==c['s3']['prefix']==bundle['source']['clusterUid'] and
            p['source']['hostUuid']==p['target']['hostUuid']==c['host']['uuid'] and
            p['source']['hostname']==p['target']['hostname']==c['host']['hostname'] and
            p['route']=='same-host-kind-010-to-k3s-090','prepared_target_backup_binding_changed')

def previous_stop_requires_review(root, uid):
    pointer=root/'current.json'
    if not pointer.exists() and not pointer.is_symlink():return
    prior=read(pointer,uid)
    import re
    require(set(prior)=={'runId'} and isinstance(prior['runId'],str) and
            re.fullmatch('[a-f0-9]{32}',prior['runId']),'previous_migration_pointer_invalid')
    state=read(root/('run-'+prior['runId'])/'journal.json',uid)
    require('sourceStopStarted' not in state or type(state['sourceStopStarted']) is bool,
            'previous_source_stop_requires_review')
    require(not state.get('sourceStopStarted') or (root/'prepared.json').exists(),
            'previous_source_stop_requires_review')


def execute(r):
    os.umask(0o077);uid=os.getuid();home=Path(r['opsHome']);require(uid>0,'local_ops_owner_required')
    require(set(r)=={'to','check','json','repository','key','snapshot','ops','bun','bin','opsHome'} and type(r['check'])is bool and type(r['json'])is bool,'closed_migrate_request_required')
    require(sys.version_info[:2]==(3,12),'qualified_python312_required')
    require(r['to']=='k3s' and not any(r.get(k)for k in ('repository','key','snapshot')),'migrate_uses_selected_host_store_generation')
    root=home/'migrate';root.mkdir(mode=0o700,exist_ok=True)
    fd=os.open(root/'run.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    run_id=uuid.uuid4().hex;work=root/('run-'+run_id);work.mkdir(mode=0o700)
    state={'status':'running','runId':run_id,'phase':'preflight','applicationRestoreVerified':False};store_lock=None
    def progress(phase,why):
        state['phase']=phase;durable_save(work/'journal.json',state);durable_save(root/'current.json',{'runId':run_id})
        if not r['json']:print('OPS migrate: '+phase+' — '+why,flush=True)
    def command(label,args,timeout=600,env=None):
        with (work/(label+'.stdout.private')).open('xb')as out,(work/(label+'.stderr.private')).open('xb')as err:
            p=subprocess.run(list(map(str,args)),stdout=out,stderr=err,timeout=timeout,env=env or os.environ)
        require(p.returncode==0,label.replace('-','_')+'_failed')
        data=(work/(label+'.stdout.private')).read_bytes()
        require(len(data)<=16*1024**2,'command_output_budget');return data
    try:
        previous_stop_requires_review(root,uid)
        progress('preflight','Verify the exact completed backup, physical host, source and immutable software inputs.')
        c=verified_store(home/'backup-store.json')
        store_lock=acquire_operation(c)
        destination,bundle=selected(c,require_metadata=False)
        require(bundle['source']['hostUuid']==hardware_uuid(),'migration_host_changed')
        require(bundle['docker']['archiveCount']>0 and bundle['docker']['sourceRecovered'] is True,'verified_docker_checkpoint_required')
        source=read(c['sourceConfig'],uid);s=source['kind']['source']
        require(s['cluster_uid']==bundle['source']['clusterUid'],'source_backup_changed')
        require(not subprocess.check_output(['git','-C',str(TASK),'status','--porcelain','--untracked-files=no']).strip(),'committed_task_code_required')
        resuming=(root/'prepared.json').exists()
        if resuming:
            pointer=read(root/'prepared.json',uid);path=Path(pointer['profile'])
            require(path.is_absolute() and path.is_relative_to(Path.home()/'.ops/profiles') and path.name=='restore.json','protected_prepared_profile_required')
            prepared=read(path,uid);resume_binding(pointer,prepared,bundle,c)
            observed=json.loads(command('inspect-prepared-target',['sudo','-n','python3','-B',TASK/'migrate/target.py','inspect']))
            require(all(prepared['target'][key]==value for key,value in observed['target'].items()),'prepared_target_identity_changed')
            state['resumingPreparedEmptyTarget']=True
        else:
            require(not Path('/usr/local/bin/k3s').exists(),'existing_target_requires_review')
            command('inspect-fresh-target',['sudo','-n','python3','-B',TASK/'migrate/install.py','check'])
        release=json.loads((TASK/'migrate/releases/local-k3s-installer.json').read_text())
        target_release=json.loads((TASK/'migrate/releases/k3s-0.9.0.json').read_text())
        for key,path in [('ops',r['ops']),('bun',r['bun'])]:
            require(digest(regular(path,uid,False))==target_release['installedTools'][key],'qualified_'+key+'_required')
        selection_path = None
        previous_selection = (prepared_selection(prepared, uid)
                              if resuming and target_release.get("optionalRuntimeImages") else None)
        select_runtimes = target_release.get("optionalRuntimeImages") and (not resuming or previous_selection is not None)
        snapshot = bundle["native"]["snapshot"] if select_runtimes else None
        if select_runtimes:
            progress("verify-runtime-inventory", "Read the runtime dependencies of the exact encrypted backup.")
            remote = RemoteRestic(destination, source, bundle["native"]["prefix"], work)
            def restic_stream(args, consume):
                stream_process(remote.common + args, work / "runtime-stream.stderr.private", consume, env=remote.env)
            selection = read_runtime_selection(snapshot, target_release["optionalRuntimeImages"], work,
                                               remote.call, restic_stream, source_uid=s["cluster_uid"])
            require(not resuming or selection == previous_selection, "prepared_runtime_selection_changed")
            target_release = selected_release(target_release, selection, snapshot)
            selection_path = work / "runtime-selection.json"
            durable_save(selection_path, selection)
            state["excludedUnusedRuntimeImages"] = selection["excludedImages"]
        images=availability(target_release['images']);durable_save(work/'image-availability.json',images)
        require(not images['missing'],'target_images_not_published')
        acquisition=acquisition_preflight(target_release['images'],work,command,target_ready=resuming,platform=release_platform(target_release))
        runtime = None
        if resuming and observed['marker'].get('schemaVersion') == 1:
            # Already prepared legacy targets keep their original daemon-off fence.
            import same_host
            same_host.source_offline()
        elif resuming:
            require(observed['marker'].get('schemaVersion') == 2, 'source_runtime_proof_required')
            runtime = source_runtime.validate_runtime(observed['marker'].get('sourceRuntime'))
            require(runtime['kindContainerId'] == s['container_id'] and
                    runtime['dockerDaemonId'] == s['docker_daemon_id'] and
                    runtime['dockerContext'] == s['docker_context'] and
                    runtime['kindCluster'] == s['kind_cluster'], 'prepared_source_runtime_changed')
            source_runtime.verify(runtime)
        else:
            plan_path = root/'host-services.json'
            def current_plan():
                return read(plan_path,uid) if plan_path.exists() or plan_path.is_symlink() else {'schemaVersion':1,'containers':[]}
            plan = current_plan()
            runtime = source_runtime.freeze(s,source_runtime.observe(),plan)
            source_runtime.verify(runtime,all_stopped=False)
            if runtime['containers'][-1]['wasRunning']:
                from kind_adapter import KindConfig,cluster_identity,Runner
                cluster_identity(KindConfig(source['kind']),Runner())
            durable_save(work/'source-runtime.private.json',runtime)
            durable_save(work/'restart-proposal.private.json',{'automaticRestart':False,
                 'containers':source_runtime.restart_candidates(runtime)})
        if r['check']:
            state.update(status='check_passed',backupRunId=bundle['runId'],clusterMutation=False);durable_save(work/'journal.json',state);print(json.dumps(state));return 0
        progress('verify-selected-archive','Retrieve and verify the encrypted native set from the same completed backup generation.')
        archive=hydrate_native(c)
        require(not snapshot or (archive["snapshot"] == snapshot and archive["runId"] == bundle["runId"]),
                "runtime_selection_snapshot_changed")
        durable_save(work/'selected-archive.private.json',archive);state['backupRunId']=archive['runId']
        if not resuming:
            progress('fetch-pinned-installer','Download the pinned K3s binary, installer and certificate controller before stopping source containers.')
            for name,key in [('k3s','binary'),('install.sh','installer'),('cert-manager.yaml','certManager')]:
                download(release[key]['url'],work/name,release[key]['sha256'],limit=256*1024**2)
            routes=json.loads(subprocess.check_output(['ip','-j','-4','route','show','default']));require(len(routes)==1,'one_primary_interface_required')
            request=work/'install-request.json';durable_save(request,{'uid':uid,'hostUuid':c['host']['uuid'],'address':c['host']['address'],
                  'interface':routes[0]['dev'],'work':str(work),'runId':run_id,'backupRunId':archive['runId'],
                  'sourceRuntime':runtime})
            # Hydration/installer staging and concurrent source writes may have
            # reduced free space since initial metadata inspection. Revalidate
            # the full remaining image bound before source downtime begins.
            check_remaining(acquisition,work,command)
            progress('stop-source-containers','Stop explicitly selected external services, then Kind; keep Docker available.')
            state['sourceStopStarted']=True;durable_save(work/'journal.json',state)
            def stop(args):
                require(current_plan()==plan,'external_stop_plan_changed')
                source_runtime.native_command(args, lambda argv, **kw: command('stop-container-'+argv[-1],argv,timeout=330,env=kw['env']))
            require(current_plan()==plan,'external_stop_plan_changed')
            source_runtime.stop_selected(runtime,stop,lambda value:durable_save(work/'container-stop.private.json',value))
            progress('install-k3s','Create the fresh pinned K3s control plane on this host; the encrypted backup remains outside it.')
            command('install-k3s',['sudo','-n','python3','-B',TASK/'migrate/install.py',request],timeout=900)
            k=['sudo','-n','/usr/local/bin/k3s','kubectl','--kubeconfig=/etc/rancher/k3s/k3s.yaml']
            await_nodes(k,work)
            command('wait-node',k+['wait','nodes','--all','--for=condition=Ready','--timeout=240s'],timeout=270)
            progress('bootstrap-target','Install the pinned certificate controller and wait for all standard K3s controllers.')
            command('install-cert-manager',k+['apply','-f',str(work/'cert-manager.yaml')])
            for ns,names in [('kube-system',['coredns','local-path-provisioner','metrics-server','traefik']),('cert-manager',['cert-manager','cert-manager-cainjector','cert-manager-webhook'])]:
                for name in names:
                    await_deployment(k,ns,name,work)
                    command('wait-'+ns+'-'+name,k+['rollout','status','deployment/'+name,'-n',ns,'--timeout=300s'],timeout=330)
            # Let standard Helm jobs and the load balancer settle before binding a
            # strict empty target. This wait does not relax the target inspector.
            for attempt in range(90):
                p=subprocess.run(['sudo','-n','python3','-B',str(TASK/'migrate/target.py'),'inspect'],capture_output=True)
                if p.returncode==0:break
                if attempt==89:
                    durable_save(work/'target-bootstrap-failure.private.json',{'stdout':p.stdout.decode(),'stderr':p.stderr.decode()});raise ValueError('empty_k3s_target_not_ready')
                time.sleep(2)
        else:
            progress('verify-prepared-target','Reuse only the exact bound empty target and verified software capsule; application restore has not started.')
        if runtime is not None:source_runtime.verify(runtime)
        progress('prepare-restore','Assemble verified 0.9.0 inputs and bind the new target to the exact selected native snapshot.')
        prep={**r,'repository':archive['repository'],'key':archive['passwordFile'],'snapshot':archive['snapshot'],'check':False}
        if selection_path:
            prep["runtimeSelection"] = str(selection_path)
        prep_path=work/'prepare-request.json';durable_save(prep_path,prep)
        command('prepare-restore',['python3','-B',TASK/'migrate/prepare.py',prep_path],timeout=14400)
        pointer=read(root/'prepared.json',uid);prepared=read(pointer['profile'],uid);target_tmp=Path(prepared['target']['opsHome'])/'tmp'
        regular(target_tmp/'kubeconfig',uid)
        env={**os.environ,'OPS_HOME':str(home),'OPS_ROOT':str(TASK),'OPS_TMP':str(target_tmp),'KUBECONFIG':str(target_tmp/'kubeconfig'),'PYTHONDONTWRITEBYTECODE':'1'}
        if runtime is not None:source_runtime.verify(runtime)
        progress('prepare-kubernetes','Apply the target CRDs and RBAC through the existing OPS task.')
        command('prepare-kubernetes',[r['ops'],'setup','kubernetes','prepare'],env=env)
        if runtime is not None:source_runtime.verify(runtime)
        progress('restore-preflight','Verify archive, target identity and every required restore capability.')
        command('restore-check',[r['ops'],'restore','--check'],env=env,timeout=1800)
        if runtime is not None:source_runtime.verify(runtime)
        progress('restore','Restore platform definitions, credentials and native data; reconcile IAM after the final data restore.')
        command('restore',[r['ops'],'restore'],env=env,timeout=14400)
        progress('sync-client','Select the new cluster client while preserving the original kind client for rollback.')
        client=home/'tmp/kubeconfig';regular(client,uid)
        previous=work/'source-client-before-switch.private.yaml';previous.write_bytes(client.read_bytes());previous.chmod(0o600)
        temporary=client.with_name('kubeconfig.'+uuid.uuid4().hex+'.tmp');temporary.write_bytes((target_tmp/'kubeconfig').read_bytes());temporary.chmod(0o600);temporary.replace(client)
        state.update(status='complete',applicationAcceptanceRequired=True,sourceDockerStoppedAndDisabled=runtime is None,sourceKindStopped=True,
                     dockerDaemonPreserved=runtime is not None,externalRestartAutomatic=False,targetVersion='0.9.0')
        durable_save(work/'journal.json',state);print(json.dumps(state));return 0
    except Exception:
        state['status']='failed';failure={'traceback':traceback.format_exc()}
        for path,value in [(work/'journal.json',state),(work/'failure.private.json',failure)]:
            try:durable_save(path,value)
            except Exception:pass  # original durable stop fence remains authoritative
        print('OPS migrate stopped at '+state['phase']+'. Available private evidence retained; subsequent phases were not executed.',file=sys.stderr);return 1
    finally:
        if store_lock is not None:os.close(store_lock)
        os.close(fd)

if __name__=='__main__':sys.exit(execute(read(sys.argv[1],os.getuid())))
