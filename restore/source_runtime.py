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

"""Versioned local Docker evidence for Kind-only migration; never start services."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess

from lib import require, regular

DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
SHA = re.compile(r'[a-f0-9]{64}\Z')
DAEMON = re.compile(r'[A-Za-z0-9:_-]{1,128}\Z')
DISPOSITIONS = {'retain-docker', 'move-to-k3s', 'keep-stopped'}
FORMAT = ('{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},'
          '"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},'
          '"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},'
          '"kindCluster":{{json (index .Config.Labels "io.x-k8s.kind.cluster")}}}')


def local_socket():
    regular('/usr/bin/docker', 0, private=False)
    path = Path('/var/run/docker.sock')
    require(not path.is_symlink(), 'local_docker_socket_required')
    info = path.stat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o002,
            'protected_local_docker_socket_required')


def native_command(args, execute=None):
    local_socket()
    env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
           'HOME': '/root' if os.geteuid() == 0 else str(Path.home()), 'LANG': 'C.UTF-8'}
    return (execute or subprocess.check_output)(args, timeout=30, env=env)


def text(value):
    return value.decode() if isinstance(value, bytes) else value


def observe(execute=None):
    def read(args):return native_command(DOCKER + args, execute)
    daemon = text(read(['info', '--format', '{{.ID}}'])).strip()
    require(DAEMON.fullmatch(daemon), 'explicit_local_docker_daemon_required')
    ids = text(read(['ps', '-aq', '--no-trunc'])).split()
    require(0 < len(ids) <= 256 and len(ids) == len(set(ids)) and all(SHA.fullmatch(i) for i in ids),
            'bounded_exact_container_inventory_required')
    raw = read(['inspect', '--format', FORMAT, *sorted(ids)])
    require(len(raw) <= 1024**2, 'container_inventory_budget_exceeded')
    rows = [json.loads(line) for line in text(raw).splitlines()]
    require(len(rows) == len(ids) and {r.get('id') for r in rows} == set(ids),
            'complete_container_inventory_required')
    for row in rows:
        require(set(row) == {'id','image','running','paused','restarting','restartPolicy','kindCluster'} and
                re.fullmatch(r'sha256:[a-f0-9]{64}', row['image']) and
                all(type(row[k]) is bool for k in ('running','paused','restarting')) and
                not row['paused'] and not row['restarting'] and
                row['restartPolicy'] in {'no','always','unless-stopped','on-failure'} and
                (row['kindCluster'] is None or isinstance(row['kindCluster'], str)),
                'stable_container_identity_required')
    return {'daemonId': daemon, 'containers': sorted(rows, key=lambda r:r['id'])}


def validate_plan(plan, source_id):
    require(type(plan) is dict and set(plan) == {'schemaVersion','containers'} and
            type(plan['schemaVersion']) is int and plan['schemaVersion'] == 1 and
            type(plan['containers']) is list and len(plan['containers']) <= 255,
            'closed_host_services_plan_required')
    ids = []
    for row in plan['containers']:
        require(type(row) is dict and set(row) == {'id','disposition'} and
                isinstance(row['id'],str) and SHA.fullmatch(row['id']) and row['id'] != source_id and
                row['disposition'] in DISPOSITIONS, 'explicit_external_container_selection_required')
        ids.append(row['id'])
    require(len(ids) == len(set(ids)), 'duplicate_external_container_selection')
    return plan


def validate_runtime(value):
    require(type(value) is dict and set(value) == {'schemaVersion','dockerContext','dockerDaemonId',
            'kindContainerId','kindCluster','containers'} and type(value['schemaVersion']) is int and
            value['schemaVersion'] == 1 and value['dockerContext'] == 'default' and
            isinstance(value['dockerDaemonId'],str) and DAEMON.fullmatch(value['dockerDaemonId']) and
            isinstance(value['kindContainerId'],str) and SHA.fullmatch(value['kindContainerId']) and
            isinstance(value['kindCluster'],str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}',value['kindCluster']) and
            type(value['containers']) is list and 0 < len(value['containers']) <= 256,
            'closed_source_runtime_required')
    ids = []
    for row in value['containers']:
        require(type(row) is dict and set(row) == {'id','image','wasRunning','restartPolicy','disposition'} and
                isinstance(row['id'],str) and SHA.fullmatch(row['id']) and
                isinstance(row['image'],str) and re.fullmatch(r'sha256:[a-f0-9]{64}',row['image']) and
                type(row['wasRunning']) is bool and
                row['restartPolicy'] in {'no','always','unless-stopped','on-failure'} and
                row['disposition'] in DISPOSITIONS | {'source-kind'}, 'closed_runtime_container_required')
        require((row['id'] == value['kindContainerId']) == (row['disposition'] == 'source-kind'),
                'exact_source_kind_disposition_required')
        require(row['disposition'] != 'keep-stopped' or not row['wasRunning'], 'keep_stopped_must_be_stopped')
        ids.append(row['id'])
    require(len(ids) == len(set(ids)) and value['containers'][-1]['id'] == value['kindContainerId'],
            'unique_inventory_with_kind_last_required')
    return value


def freeze(source, observed, plan):
    require(source['docker_context'] == 'default' and observed['daemonId'] == source['docker_daemon_id'],
            'docker_daemon_identity_changed')
    plan = validate_plan(plan, source['container_id'])
    rows = {r['id']: r for r in observed['containers']}
    require(source['container_id'] in rows and rows[source['container_id']]['kindCluster'] == source['kind_cluster'],
            'source_container_changed')
    selected = {r['id']:r['disposition'] for r in plan['containers']}
    require(set(selected) <= rows.keys(), 'selected_external_container_missing')
    for row in rows.values():
        if row['id'] == source['container_id']:continue
        require(not row['kindCluster'], 'additional_kind_cluster_requires_review')
        require(not row['running'] or row['id'] in selected, 'foreign_running_docker_workload')
        require(selected.get(row['id']) != 'keep-stopped' or not row['running'], 'keep_stopped_must_be_stopped')
    order = [r['id'] for r in plan['containers']] + sorted(set(rows) - set(selected) - {source['container_id']}) + [source['container_id']]
    result = {'schemaVersion':1,'dockerContext':'default','dockerDaemonId':observed['daemonId'],
              'kindContainerId':source['container_id'],'kindCluster':source['kind_cluster'],'containers':[]}
    for ident in order:
        row=rows[ident]
        result['containers'].append({'id':ident,'image':row['image'],'wasRunning':row['running'],
                                    'restartPolicy':row['restartPolicy'],
                                    'disposition':'source-kind' if ident == source['container_id'] else selected.get(ident,'keep-stopped')})
    return validate_runtime(result)


def verify(runtime, *, stopped=None, all_stopped=True, execute=None):
    validate_runtime(runtime)
    observed = observe(execute)
    require(observed['daemonId'] == runtime['dockerDaemonId'], 'docker_daemon_identity_changed')
    rows={r['id']:r for r in observed['containers']}
    require(set(rows) == {r['id'] for r in runtime['containers']}, 'source_container_inventory_changed')
    stopped=set(stopped or [])
    for expected in runtime['containers']:
        row=rows[expected['id']]
        require(row['image'] == expected['image'] and row['restartPolicy'] == expected['restartPolicy'],
                'source_container_identity_changed')
        require(row['kindCluster'] == (runtime['kindCluster'] if row['id'] == runtime['kindContainerId'] else None),
                'source_kind_label_changed')
        wanted=False if all_stopped or row['id'] in stopped else expected['wasRunning']
        require(row['running'] == wanted, 'source_container_state_changed')
    return True


def stop_selected(runtime, command, persist):
    validate_runtime(runtime)
    # Caller freezes durable evidence BEFORE the first effect. Every stop is
    # preceded by a fresh exact inventory check. Never retry a partial stop.
    stopped=[]
    for row in runtime['containers']:
        verify(runtime, stopped=stopped, all_stopped=False)
        if row['wasRunning']:
            persist({'stopped':list(stopped),'nextContainerId':row['id']})
            command(DOCKER + ['stop','--time','300',row['id']])
        stopped.append(row['id'])
    verify(runtime)
    persist({'stopped':list(stopped),'nextContainerId':None})


def restart_candidates(runtime):
    validate_runtime(runtime)
    return [r['id'] for r in runtime['containers'] if r['wasRunning'] and r['disposition'] == 'retain-docker']
