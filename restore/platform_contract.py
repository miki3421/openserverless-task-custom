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

"""Explicit platform primitives; not an ARM64 operational qualification gate.

Current persisted restore profiles remain schema1/AMD64. Pure ARM64 helpers
prepare a future complete contract without accepting new profiles or markers.
Never infer the platform from the executing host, environment or path.
"""

PLATFORMS={'linux/amd64':('amd64',62), 'linux/arm64':('arm64',183)}


def architecture(selected):
    if type(selected) is not str or selected not in PLATFORMS:
        raise ValueError('explicit_qualified_platform_required')
    return PLATFORMS[selected][0]


def release_platform(release):
    # An absent field means the existing predecessor contract, always AMD64.
    selected=release.get('platform','linux-amd64')
    if selected not in ('linux-amd64','linux-arm64'):
        raise ValueError('explicit_release_platform_required')
    return 'linux/'+selected[6:]


def profile_platform(profile):
    # schemaVersion2 on root/target markers already means sourceRuntime proof.
    # It does NOT opt a restore profile into a different native architecture.
    if type(profile.get('schemaVersion')) is not int or profile['schemaVersion']!=1:
        raise ValueError('unsupported_restore_platform_contract')
    if 'platform' in profile or 'platform' in profile.get('target',{}):
        raise ValueError('legacy_profile_platform_override_rejected')
    return 'linux/amd64'


def binary_directory(selected):
    return '.ops/linux-'+architecture(selected)+'/bin'


def elf_identity(header,selected):
    architecture(selected)
    return (len(header)>=20 and header[:6]==b'\x7fELF\x02\x01'
            and int.from_bytes(header[18:20],'little')==PLATFORMS[selected][1])
