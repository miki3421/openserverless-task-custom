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

"""Read only the runtime inventory from the exact sealed migration archive."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
from threading import Timer

from lib import require, private_json, selected_snapshot
from offline_runtimes import artifact_path, logical_documents, repository_of, runtime_selection
from qualify_arm64 import closed_json
from store_common import regular, digest

ARCHIVE_LIMIT = 32 * 1024**3
INVENTORY_LIMIT = 512 * 1024**2
INVENTORY_NAMES = {"receipt.json", "platform-configuration.json", "openwhisk-export.json",
                   "database-0.ndjson", "database-1.ndjson"}


class ArchiveReader:
    def __init__(self, source):
        self.source = source
        self.remaining = ARCHIVE_LIMIT

    def read(self, size):
        data = self.source.read(min(size, self.remaining + 1))
        self.remaining -= len(data)
        require(self.remaining >= 0, "runtime_archive_budget_exceeded")
        return data


def inventory_files(stream, destination, proof):
    members = proof.get("files")
    require(type(members) is list and members, "complete_runtime_archive_proof_required")
    expected = {row["file"]: row for row in members}
    require(len(expected) == len(members)
            and all(type(row["bytes"]) is int and row["bytes"] >= 0 for row in members)
            and sum(row["bytes"] for row in members) <= ARCHIVE_LIMIT, "runtime_archive_proof_invalid")
    selected = {name for name in expected if name == "receipt.json"
                or name.startswith("artifacts/") and PurePosixPath(name).name in INVENTORY_NAMES}
    require(sum(expected[name]["bytes"] for name in selected) <= INVENTORY_LIMIT, "runtime_inventory_budget_exceeded")

    seen = set()
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            require(member.name == str(name) and not name.is_absolute() and ".." not in name.parts
                    and "\\" not in member.name and member.name in expected and member.name not in seen
                    and member.isfile() and not member.mode & 0o077, "unsafe_runtime_archive_member")
            row = expected[member.name]
            require(member.size == row["bytes"], "runtime_archive_member_size_changed")
            seen.add(member.name)
            if member.name not in selected:
                continue
            path = destination.joinpath(*name.parts)
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with archive.extractfile(member) as source, path.open("xb") as target:
                os.fchmod(target.fileno(), 0o600)
                checksum = hashlib.sha256()
                while block := source.read(1024**2):
                    target.write(block)
                    checksum.update(block)
            require(checksum.hexdigest() == row["sha256"], "runtime_inventory_checksum_changed")
    require(seen == expected.keys(), "incomplete_runtime_archive")


def archive_catalog(payload):
    receipt = private_json(payload / "receipt.json")
    items = [entry for component in receipt["components"] if component["id"] == "platform-configuration"
             for entry in component["files"] if Path(entry["path"]).name == "platform-configuration.json"]
    require(len(items) == 1, "one_runtime_source_catalog_required")
    item = items[0]
    path = artifact_path(payload, item["path"])
    require(path.stat().st_size == item["bytes"] and digest(path) == item["sha256"],
            "runtime_inventory_checksum_changed")
    configuration = private_json(path, limit=32 * 1024**2)
    catalogs = [row["data"]["runtimes.json"] for row in configuration["resources"]
                if row["kind"] == "ConfigMap" and row["metadata"]["name"] == "openwhisk-runtimes"]
    require(len(catalogs) == 1, "one_runtime_source_catalog_required")
    return closed_json(catalogs[0].encode())


def read_runtime_selection(snapshot, optional, work, call, stream, *, source_uid):
    """The same Restic snapshot supplies the file proofs and the tar stream."""
    require(isinstance(snapshot, str) and re.fullmatch("[a-f0-9]{64}", snapshot), "runtime_snapshot_required")
    collection = selected_snapshot(json.loads(call("runtime-snapshots", ["snapshots", "--json"])),
                                   snapshot, ARCHIVE_LIMIT)
    app = collection / "applications/nuvolaris"
    proof = closed_json(call("runtime-member-proof", ["dump", snapshot, str(app / "ops-native-manifest.json")]))
    require(type(proof.get("schemaVersion")) is int and proof["schemaVersion"] == 1
            and proof.get("verifiedBy") == "ops-native-verify-payload"
            and proof.get("sourceClusterUid") == source_uid, "runtime_inventory_source_changed")
    with tempfile.TemporaryDirectory(prefix="runtime-inventory-", dir=work) as directory:
        payload = Path(directory)
        stream(["dump", snapshot, str(app / "ops-native.tar")],
               lambda output: inventory_files(output, payload, proof))
        result, _ = runtime_selection(archive_catalog(payload), logical_documents(payload), optional, snapshot)
    return result


def stream_process(args, log, consumer, *, env=None):
    with log.open("xb") as error, subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                                   stderr=error, env=env) as process:
        timer = Timer(1800, process.kill)
        timer.start()
        try:
            with process.stdout as output:
                bounded = ArchiveReader(output)
                consumer(bounded)
                while bounded.read(1024**2):
                    pass
            require(process.wait() == 0, "runtime_archive_read_failed")
        finally:
            timer.cancel()
            if process.poll() is None:
                process.kill()


def selected_release(release, proof, snapshot):
    optional = release.get("optionalRuntimeImages")
    if optional is None:
        require(proof is None, "unexpected_runtime_selection")
        return release
    require(type(optional) is list and optional and all(type(ref) is str for ref in optional)
            and len(optional) == len(set(optional)), "invalid_optional_runtime_images")
    require(type(proof) is dict and set(proof) == {
        "schemaVersion", "snapshot", "optionalImages", "excludedImages", "catalogSha256"
    } and type(proof["schemaVersion"]) is int and proof["schemaVersion"] == 1
        and proof["snapshot"] == snapshot and proof["optionalImages"] == sorted(optional)
        and type(proof["excludedImages"]) is list
        and all(type(ref) is str for ref in proof["excludedImages"])
        and proof["excludedImages"] == sorted(set(proof["excludedImages"]))
        and set(proof["excludedImages"]).issubset(optional)
        and type(proof["catalogSha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", proof["catalogSha256"]),
        "bound_runtime_selection_required")
    references = {row["reference"] for row in release["images"]}
    require(set(optional).issubset(references)
            and not {repository_of(ref) for ref in optional}.intersection(
                repository_of(value) for value in release["target"]["images"].values()),
            "optional_runtime_cannot_be_platform_image")
    return {**release, "images": [row for row in release["images"]
                                 if row["reference"] not in proof["excludedImages"]]}


def prepared_selection(profile, uid):
    assets = Path(profile["assets"]["directory"])
    path = regular(assets / "manifest.json", uid)
    require(digest(path) == profile["assets"]["manifestSha256"], "prepared_asset_manifest_changed")
    manifest = private_json(path, uid)
    name = "runtime-selection.json"
    if name not in manifest["files"]:
        return None
    proof = regular(assets / name, uid)
    row = manifest["files"][name]
    require(proof.stat().st_size == row["bytes"] and digest(proof) == row["sha256"],
            "prepared_runtime_selection_changed")
    return private_json(proof, uid)
