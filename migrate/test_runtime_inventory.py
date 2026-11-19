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

import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import sys

TASK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(TASK / "migrate"), str(TASK / "restore"), str(TASK / "backup/engine/scripts")]
from runtime_inventory import inventory_files, read_runtime_selection, selected_release, prepared_selection
from offline_runtimes import catalog_hash, missing_runtime_images, prepare_runtime_selection, required_runtime_images, runtime_selection

RELEASE = json.loads((TASK / "migrate/releases/k3s-0.9.0.json").read_text())
OPTIONAL = RELEASE["optionalRuntimeImages"]
SNAPSHOT = "a" * 64
UID = "synthetic-cluster"
MANIFEST = {"files": {"runtime-selection.json": {}}}


def entry(kind, reference, default=True):
    prefix, _, image = reference.rpartition("/")
    name, _, tag = image.rpartition(":")
    return {"kind": kind, "default": default, "image": {"prefix": prefix, "name": name, "tag": tag}}


def catalog():
    return {"runtimes": {
        "dotnet": [entry("dotnet:2.2", OPTIONAL[0])],
        "ruby": [entry("ruby:2.5", OPTIONAL[1])],
        "rust": [entry("rust:1.34", OPTIONAL[2])],
        "python": [entry("python:sys", "docker.io/synthetic/python:sys", False)],
    }}


def entity(kind, namespace="OTHER-TENANT", **kwargs):
    return {"_id": namespace + "/action", "_rev": "1-synthetic", "namespace": namespace, "name": "action",
            "exec": {"kind": kind, **kwargs}}


def record(name, content):
    return {"path": name, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}


def packet(documents, *, expected_entities=None, entity_count=None, database_count=2):
    if expected_entities is None:
        expected_entities = [
            {"id": item["_id"], "revision": item["_rev"], "namespace": item["namespace"],
             "name": item["name"], "type": "action", "runtime": item["exec"]["kind"]} for item in documents
        ]
    entities = b"".join(json.dumps(doc).encode() + b"\n" for doc in documents)
    subjects = b'{"_id":"account","_rev":"1-synthetic","namespaces":[]}\n'
    export = {
        "kind": "ops-protected-openwhisk-export", "schemaVersion": 1,
        "namespaces": [{"name": "OTHER-TENANT", "entities": expected_entities}],
        "databases": [
            {"name": "subjects", "file": "database-0.ndjson", "documents": 1},
            {"name": "entities", "file": "database-1.ndjson",
             "documents": len(documents) if entity_count is None else entity_count},
        ][:database_count],
    }
    config_name = "platform/platform-configuration.json"
    config = json.dumps({"resources": [{"kind": "ConfigMap", "metadata": {"name": "openwhisk-runtimes"},
                                       "data": {"runtimes.json": json.dumps(catalog())}}]}).encode()
    data = {"whisk/openwhisk-export.json": json.dumps(export).encode(),
            "whisk/database-0.ndjson": subjects, "whisk/database-1.ndjson": entities}
    receipt = {"components": [
        {"id": "platform-configuration", "files": [record(config_name, config)]},
        {"id": "openwhisk-resources", "files": [record(name, content) for name, content in data.items()]},
    ]}
    files = {**{"artifacts/" + name: content for name, content in data.items()},
             "artifacts/" + config_name: config, "receipt.json": json.dumps(receipt).encode(),
             "artifacts/backend/raw.bin": b"backend must not be extracted for inventory"}
    proof = {"schemaVersion": 1, "verifiedBy": "ops-native-verify-payload", "sourceClusterUid": UID,
             "files": [{"file": name, "bytes": row["bytes"], "sha256": row["sha256"]}
                       for name, content in files.items() for row in [record(name, content)]]}
    return proof, files


def tar_bytes(files):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for name, content in files.items():
            member = tarfile.TarInfo(name)
            member.mode = 0o600
            member.size = len(content)
            tar.addfile(member, io.BytesIO(content))
    return raw.getvalue()


def inspect(root, proof, files):
    def call(_label, args):
        if args[0] == "snapshots":
            return json.dumps([{"id": SNAPSHOT, "paths": ["/synthetic/collection"]}]).encode()
        assert args == ["dump", SNAPSHOT, "/synthetic/collection/applications/nuvolaris/ops-native-manifest.json"]
        return json.dumps(proof).encode()

    def stream(args, reader):
        assert args == ["dump", SNAPSHOT, "/synthetic/collection/applications/nuvolaris/ops-native.tar"]
        reader(io.BytesIO(tar_bytes(files)))

    return read_runtime_selection(SNAPSHOT, OPTIONAL, root, call, stream, source_uid=UID)


class RuntimeInventory(unittest.TestCase):
    def test_unused_legacy_families_are_omitted_and_system_kept(self):
        original = catalog()
        result, selected = runtime_selection(original, [], OPTIONAL, SNAPSHOT)
        self.assertEqual(set(result["excludedImages"]), set(OPTIONAL))
        self.assertEqual(set(selected["runtimes"]), {"python"})
        self.assertEqual(set(original["runtimes"]), {"dotnet", "ruby", "rust", "python"})
        eligible = selected_release(RELEASE, result, SNAPSHOT)
        self.assertEqual(len(RELEASE["images"]) - len(eligible["images"]), 3)
        self.assertEqual(eligible["target"], RELEASE["target"])

    def test_tenant_default_saved_nondefault_and_registry_alias_preserve_family(self):
        parsed = [entity("dotnet:default", "OTHER-TENANT"),
                  entity("ruby:2.6", "ANOTHER-TENANT"),
                  entity("blackbox", "THIRD-TENANT", image=OPTIONAL[2] + "@sha256:" + SNAPSHOT)]
        source = catalog()
        source["runtimes"]["ruby"].append(entry("ruby:2.6", "docker.io/synthetic/ruby:2.6", False))
        binding, selected = runtime_selection(source, parsed, OPTIONAL, SNAPSHOT)
        self.assertEqual(binding["excludedImages"], [])
        self.assertEqual(selected, source)
        binding, _ = runtime_selection(catalog(), [entity("blackbox", image="index.docker.io/openwhisk/action-dotnet-v2.2:other")],
                                       OPTIONAL, SNAPSHOT)
        self.assertNotIn(OPTIONAL[0], binding["excludedImages"])

    def test_source_tag_alias_is_eligible_but_kept_for_a_saved_action(self):
        source = catalog()
        source["runtimes"]["dotnet"][0]["image"]["tag"] = "original"
        proof, selected = runtime_selection(source, [], OPTIONAL, SNAPSHOT)
        self.assertIn(OPTIONAL[0], proof["excludedImages"])
        self.assertNotIn("dotnet", selected["runtimes"])
        proof, selected = runtime_selection(source, [entity("dotnet:default")], OPTIONAL, SNAPSHOT)
        self.assertNotIn(OPTIONAL[0], proof["excludedImages"])
        self.assertEqual(selected["runtimes"]["dotnet"], source["runtimes"]["dotnet"])

    def test_nonoptional_sibling_default_and_platform_prewarm_are_preserved(self):
        source = catalog()
        legacy = entry("ruby:2.5", OPTIONAL[1], False)
        modern = entry("ruby:3.2", "docker.io/synthetic/ruby:3.2")
        source["runtimes"]["ruby"] = [legacy, modern]
        source["runtimes"]["rust"][0]["stemCells"] = [{"initialCount": 1}]
        proof, selected = runtime_selection(source, [], OPTIONAL, SNAPSHOT)
        self.assertEqual(selected["runtimes"]["ruby"], [modern])
        self.assertEqual(selected["runtimes"]["rust"], source["runtimes"]["rust"])
        self.assertIn(OPTIONAL[1], proof["excludedImages"])
        self.assertNotIn(OPTIONAL[2], proof["excludedImages"])
        legacy["default"], modern["default"] = True, False
        proof, selected = runtime_selection(source, [], OPTIONAL, SNAPSHOT)
        self.assertEqual(selected["runtimes"]["ruby"], [legacy, modern])
        self.assertNotIn(OPTIONAL[1], proof["excludedImages"])

    def test_selected_closure_requires_source_prewarm_and_configured_blackbox_alias(self):
        source = catalog()
        prewarm = source["runtimes"]["rust"][0]
        prewarm["default"] = False
        prewarm["image"]["tag"] = "source-native"
        prewarm["stemCells"] = [{"initialCount": 1}]
        source["runtimes"]["rust"].append(entry("rust:1.35", "docker.io/synthetic/rust:1.35"))
        configured = {"prefix": "index.docker.io/openwhisk", "name": "action-dotnet-v2.2", "tag": "pinned"}
        source["blackboxes"] = [configured]
        proof, selected = runtime_selection(source, [], OPTIONAL, SNAPSHOT)
        self.assertNotIn(OPTIONAL[0], proof["excludedImages"])
        self.assertNotIn(OPTIONAL[2], proof["excludedImages"])
        prewarm_image = "docker.io/openwhisk/action-rust-v1.34:source-native"
        blackbox_image = "docker.io/openwhisk/action-dotnet-v2.2:pinned"
        required = required_runtime_images(selected, [], selected_catalog=True)
        cached = [ref for ref in required if ref not in {prewarm_image, blackbox_image}] + OPTIONAL
        self.assertEqual(missing_runtime_images(required, cached), [blackbox_image, prewarm_image])
        self.assertNotIn(prewarm_image, required_runtime_images(source, []))
        self.assertNotIn(blackbox_image, required_runtime_images(source, []))

    def test_unresolved_action_runtime_and_malformed_exec_fail_closed(self):
        for document in (entity("unavailable:default"), entity("unavailable:1"), {"exec": None}, {"exec": {}}):
            with self.subTest(document=document), self.assertRaises(ValueError):
                runtime_selection(catalog(), [document], OPTIONAL, SNAPSHOT)

    def test_snapshot_digest_scope_and_platform_images_cannot_change(self):
        proof, _ = runtime_selection(catalog(), [], OPTIONAL, SNAPSHOT)
        with self.assertRaisesRegex(ValueError, "bound_runtime_selection"):
            selected_release(RELEASE, proof, "b" * 64)
        drifted = {**RELEASE, "target": {"images": {"operator": OPTIONAL[0]}}}
        with self.assertRaisesRegex(ValueError, "platform_image"):
            selected_release(drifted, proof, SNAPSHOT)
        with self.assertRaisesRegex(ValueError, "bound_runtime_selection"):
            selected_release(RELEASE, {**proof, "excludedImages": ["docker.io/synthetic/foreign:1"]}, SNAPSHOT)

    def test_same_archive_binds_raw_all_tenant_action_rows_before_exclusion(self):
        with tempfile.TemporaryDirectory() as root:
            proof, files = packet([entity("dotnet:default")])
            result = inspect(root, proof, files)
            self.assertEqual(set(result["excludedImages"]), set(OPTIONAL[1:]))
            self.assertFalse(list(Path(root).iterdir()))

    def test_partial_counts_entity_revisions_and_archive_binding_fail_closed(self):
        original = entity("dotnet:default")
        wrong = [{"id": original["_id"], "revision": "2-other", "namespace": original["namespace"],
                  "name": original["name"], "type": "action", "runtime": "dotnet:default"}]
        cases = [packet([original], entity_count=2), packet([original], database_count=1),
                 packet([original], expected_entities=[]), packet([original], expected_entities=wrong)]
        bad_proof, files = packet([original])
        cases.append(({**bad_proof, "sourceClusterUid": "foreign"}, files))
        for proof, files in cases:
            with self.subTest(proof=proof), tempfile.TemporaryDirectory() as root, self.assertRaises(ValueError):
                inspect(root, proof, files)

    def test_archive_paths_content_hash_and_closed_member_set_are_enforced(self):
        proof, files = packet([])
        for name, changed in [
            ("modified", {**files, "receipt.json": b"x" * len(files["receipt.json"])}),
            ("missing", {key: value for key, value in files.items() if key != "receipt.json"}),
            ("extra", {**files, "../escape": b"x"}),
        ]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root, self.assertRaises(ValueError):
                inventory_files(io.BytesIO(tar_bytes(changed)), Path(root), proof)

    def test_restore_rechecks_selection_against_unpacked_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proof, files = packet([entity("rust:1.34")])
            runtime_proof = inspect(root, proof, files)
            payload = root / "unpack/payload"
            payload.mkdir(parents=True, mode=0o700)
            inventory_files(io.BytesIO(tar_bytes(files)), payload, proof)
            (root / "inputs").mkdir(mode=0o700)
            source = root / "source-runtimes.json"
            source.write_text(json.dumps(catalog()))
            source.chmod(0o600)
            pin = root / "inputs/runtime-selection.json"
            pin.write_text(json.dumps(runtime_proof))
            pin.chmod(0o600)
            profile = {"route": "same-host-kind-010-to-k3s-090", "archive": {"snapshot": SNAPSHOT}}
            digest = prepare_runtime_selection(root, profile, MANIFEST, OPTIONAL)
            actual = json.loads((root / "selected-runtimes.json").read_text())
            self.assertEqual(digest, catalog_hash(actual))
            self.assertEqual(set(actual["runtimes"]), {"rust", "python"})
            pin.write_text(json.dumps({**runtime_proof, "excludedImages": list(OPTIONAL)}))
            with self.assertRaisesRegex(ValueError, "archived_runtime_selection_changed"):
                prepare_runtime_selection(root, profile, MANIFEST, OPTIONAL)

    def test_old_prepared_assets_and_isolated_route_keep_full_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = root / "manifest.json"
            old.write_text('{"files":{}}')
            old.chmod(0o600)
            profile = {"route": "kind-010-to-k3s-090", "assets": {
                "directory": tmp, "manifestSha256": hashlib.sha256(old.read_bytes()).hexdigest()}}
            self.assertIsNone(prepared_selection(profile, None))
            self.assertIsNone(prepare_runtime_selection(root, profile, {"files": {}}, OPTIONAL))
            with self.assertRaisesRegex(ValueError, "unexpected_runtime_selection"):
                prepare_runtime_selection(root, profile, MANIFEST, OPTIONAL)
