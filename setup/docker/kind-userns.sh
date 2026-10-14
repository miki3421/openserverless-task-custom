#!/bin/sh
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
set -eu
# Kind's masked sysfs prevents sysfs mounts in nested user namespaces.
# Keep an additional complete, read-only sysfs in the NODE, never in a pod.
# https://github.com/kubernetes-sigs/kind/issues/3436
[ -d /kind ] && [ ! -L /kind ]
chmod a+x /kind
install -d -m 0700 -o root -g root /run/ops-kind
mkdir -p /run/ops-kind/sys
if ! mountpoint -q /run/ops-kind/sys; then
    mount -t sysfs -o ro,nosuid,nodev,noexec sysfs /run/ops-kind/sys
fi
[ "$(findmnt -n -o FSTYPE --mountpoint /run/ops-kind/sys)" = sysfs ]
options=,$(findmnt -n -o OPTIONS --mountpoint /run/ops-kind/sys),
for required in ro nosuid nodev noexec; do
    case "$options" in
        *,"$required",*) ;;
        *) echo "Unsafe sysfs options: missing $required" >&2; exit 1 ;;
    esac
done
