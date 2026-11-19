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

"""Require all startup and saved-action runtime references in the offline cache."""
import hashlib,json,re,runpy
from pathlib import Path, PurePosixPath
from lib import require,private_json,regular,digest

def normalized_image(reference):
    require(isinstance(reference,str)and re.fullmatch(r'[a-zA-Z0-9._:/@-]+',reference)is not None,'invalid_runtime_image_reference')
    first=reference.split('/')[0]
    if '/'not in reference:reference='docker.io/library/'+reference
    elif '.'not in first and ':'not in first and first!='localhost':reference='docker.io/'+reference
    if reference.startswith(('index.docker.io/', 'registry.hub.docker.com/')):reference='docker.io/'+reference.split('/',1)[1]
    if '@'not in reference and ':'not in reference.rsplit('/',1)[-1]:reference+=':latest'
    return reference

def image_for(entry):
    image = entry["image"]
    require(image.get("tag"), "offline_runtime_tag_required")
    prefix = image.get("prefix", "").rstrip("/")
    return normalized_image((prefix + "/" if prefix else "") + image["name"] + ":" + image["tag"])


def repository_of(reference):
    prefix, _, leaf = normalized_image(reference).rpartition("/")
    return (prefix + "/" + leaf.split("@", 1)[0].split(":", 1)[0]).lower()


def runtime_dependencies(catalog, documents, *, strict=False):
    entries = [entry for family in catalog["runtimes"].values() for entry in family]
    by_kind = {entry["kind"]: entry for entry in entries}
    require(len(by_kind) == len(entries), "duplicate_runtime_kind")
    require(all(type(entry.get("default")) is bool for entry in entries), "invalid_runtime_default_flag")
    used, blackboxes = set(), set()
    for document in documents:
        require(type(document) is dict, "invalid_saved_runtime_document")
        executable = document.get("exec")
        if "exec" not in document or (not strict and not executable):
            continue
        require(type(executable) is dict and isinstance(executable.get("kind"), str), "invalid_saved_runtime_kind")
        kind = executable["kind"]
        if kind == "sequence":
            continue
        if kind == "blackbox":
            blackboxes.add(normalized_image(executable.get("image")))
            continue
        if kind.endswith(":default"):
            family = kind.removesuffix(":default")
            defaults = [entry["kind"] for entry in entries
                        if entry["kind"].split(":")[0] == family and entry["default"]]
            require(len(defaults) == 1, "unresolved_saved_default_runtime")
            kind = defaults[0]
        require(kind in by_kind, "saved_action_runtime_missing_from_catalog")
        used.add(kind)
    return by_kind, used, blackboxes


def required_runtime_images(catalog, documents):
    by_kind, used, blackboxes = runtime_dependencies(catalog, documents)
    return sorted(blackboxes | {image_for(entry) for kind, entry in by_kind.items()
                              if kind in used or entry["default"] or kind.endswith(":sys")})


def runtime_selection(catalog, documents, optional, snapshot):
    require(type(optional) is list and optional and len(set(optional)) == len(optional)
            and all(normalized_image(ref) == ref for ref in optional), "invalid_optional_runtime_images")
    _, used, blackboxes = runtime_dependencies(catalog, documents, strict=True)
    protected_repositories = {repository_of(ref) for ref in blackboxes}
    optional_repositories = {repository_of(ref) for ref in optional}
    filtered = {}
    retained_repositories = set()
    for family, entries in catalog["runtimes"].items():
        kept = entries
        if family in {"dotnet", "ruby", "rust"} and not any(entry["kind"] in used for entry in entries):
            kept = [entry for entry in entries
                    if repository_of(image_for(entry)) not in optional_repositories
                    or entry["kind"].endswith(":sys") or entry.get("stemCells")
                    or repository_of(image_for(entry)) in protected_repositories]
            # Preserve the default when a nonoptional variant survives.
            if kept and not any(entry["default"] for entry in kept):
                kept = [entry for entry in entries if entry in kept or entry["default"]]
        if kept:
            filtered[family] = kept
            retained_repositories.update(repository_of(image_for(entry)) for entry in kept)
    excluded = {ref for ref in optional if repository_of(ref) not in retained_repositories | protected_repositories}
    selected = {**catalog, "runtimes": filtered}
    return {
        "schemaVersion": 1, "snapshot": snapshot, "optionalImages": sorted(optional),
        "excludedImages": sorted(excluded), "catalogSha256": catalog_hash(selected),
    }, selected


def catalog_hash(catalog):
    return hashlib.sha256(json.dumps(catalog, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def entity_binding(document):
    namespace, name = document.get("namespace"), document.get("name")
    require(isinstance(namespace, str) and isinstance(name, str)
            and document["_id"] == namespace + "/" + name, "runtime_entity_identity_changed")
    if "exec" in document:
        kind = "action"
        require(type(document["exec"]) is dict
                and isinstance(document["exec"].get("kind"), str)
                and document["exec"]["kind"], "invalid_saved_runtime_kind")
        runtime = document["exec"]["kind"]
    elif "binding" in document:
        kind, runtime = "package", None
    elif "trigger" in document and "action" in document:
        kind, runtime = "rule", None
    else:
        require("parameters" in document, "unknown_runtime_inventory_entity")
        kind, runtime = "trigger", None
    require(not document.get("entityType") or document["entityType"] == kind, "runtime_entity_type_changed")
    return document["_rev"], namespace, name, kind, runtime


def artifact_path(payload, name):
    relative = PurePosixPath(name)
    require(not relative.is_absolute() and ".." not in relative.parts and chr(92) not in name
            and str(relative) == name, "unsafe_runtime_inventory_artifact")
    return regular(payload / "artifacts" / name)


def logical_documents(payload):
    receipt = private_json(payload / "receipt.json")
    items = [component["files"] for component in receipt["components"]
             if component["id"] == "openwhisk-resources"]
    require(len(items) == 1, "one_openwhisk_inventory_required")
    files = {item["path"]: item for item in items[0]}
    require(len(files) == len(items[0]), "duplicate_openwhisk_inventory_artifact")
    manifest_names = [name for name in files if name.endswith("/openwhisk-export.json")]
    require(len(manifest_names) == 1, "one_openwhisk_export_required")

    def verified(name):
        require(name in files, "runtime_inventory_artifact_missing")
        item = files[name]
        path = artifact_path(payload, name)
        require(path.stat().st_size == item["bytes"] and digest(path) == item["sha256"],
                "runtime_inventory_artifact_changed")
        return path

    manifest_name = manifest_names[0]
    manifest = private_json(verified(manifest_name), limit=32 * 1024**2)
    require(manifest.get("kind") == "ops-protected-openwhisk-export"
            and type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 1,
            "qualified_openwhisk_export_required")
    databases = manifest.get("databases")
    require(type(databases) is list and len(databases) == 2, "complete_openwhisk_export_required")
    require(len({item["file"] for item in databases}) == len({item["name"] for item in databases}) == 2
            and {item["file"] for item in databases} == {"database-0.ndjson", "database-1.ndjson"},
            "complete_openwhisk_export_required")
    namespaces = manifest.get("namespaces")
    require(type(namespaces) is list and namespaces, "complete_runtime_namespace_inventory_required")
    expected_entities = {}
    namespace_names = set()
    for namespace in namespaces:
        name = namespace["name"]
        require(type(name) is str and name and name not in namespace_names and type(namespace["entities"]) is list,
                "duplicate_runtime_inventory_namespace")
        namespace_names.add(name)
        for entity in namespace["entities"]:
            require(entity["id"] not in expected_entities and entity["namespace"].split("/", 1)[0] == name,
                    "duplicate_or_foreign_runtime_inventory_entity")
            expected_entities[entity["id"]] = (entity["revision"], entity["namespace"], entity["name"],
                                               entity["type"], entity["runtime"])
    for database in databases:
        is_entities = database["file"] == "database-1.ndjson"
        observed_entities = set()
        path = verified(str(Path(manifest_name).with_name(database["file"])))
        expected = database["documents"]
        require(type(expected) is int and expected >= 0, "runtime_inventory_count_invalid")
        count = 0
        identities = set()
        with path.open("rb") as stream:
            while line := stream.readline(64 * 1024**2 + 1):
                require(len(line) <= 64 * 1024**2 and line.strip(), "runtime_inventory_document_invalid")
                count += 1
                require(count <= expected, "runtime_inventory_count_changed")
                document = json.loads(line)
                require(type(document) is dict and type(document.get("_id")) is str
                        and document["_id"] not in identities and type(document.get("_rev")) is str
                        and document["_id"] and document["_rev"], "runtime_inventory_document_identity_invalid")
                identities.add(document["_id"])
                if is_entities and not document["_id"].startswith("_design/"):
                    require(expected_entities.get(document["_id"]) == entity_binding(document),
                            "runtime_inventory_entity_changed")
                    observed_entities.add(document["_id"])
                    yield document
        require(count == expected, "runtime_inventory_count_changed")
        if is_entities:
            require(observed_entities == expected_entities.keys(), "incomplete_runtime_entity_inventory")


def prepare_runtime_selection(root, profile, manifest, optional):
    name = "runtime-selection.json"
    if name not in manifest["files"]:
        return None
    require(profile["route"] == "same-host-kind-010-to-k3s-090" and optional, "unexpected_runtime_selection")
    expected = private_json(root / "inputs" / name)
    source = private_json(root / "source-runtimes.json")
    actual, selected = runtime_selection(source, logical_documents(root / "unpack/payload"),
                                         optional, profile["archive"]["snapshot"])
    require(actual == expected, "archived_runtime_selection_changed")
    with (root / "selected-runtimes.json").open("x") as out:
        out.write(json.dumps(selected, indent=2) + "\n")
    return actual["catalogSha256"]


def missing_runtime_images(required,cached):
    available={normalized_image(ref)for ref in cached}
    return sorted(set(required)-available)

def verify_runtime_cache(root,profile,run,*,selected_catalog=False):
    require(not(root/'adapter-journal.json').exists(),'runtime_validation_must_precede_native_restore')
    task=Path(__file__).resolve().parents[1];cache=root/'catalog-tasks.git'
    run('offline-runtime-target-task',['git','clone','--bare','--single-branch','-b','feature/migration-recovery-0.9.0',str(root/'inputs/tasks/target.bundle'),str(cache)])
    git=['git','--git-dir='+str(cache)]
    require(run('offline-runtime-target-revision',git+['rev-parse','HEAD']).decode().strip()==profile['target']['taskCommit'],'offline_runtime_task_pin_mismatch')
    target=json.loads(run('offline-runtime-target-catalog',git+['show','HEAD:runtimes.json']))
    merge=runpy.run_path(str(task/'upgrade/adapters/runtime_catalog.py'))['merge_system_runtimes']
    source_name = "selected-runtimes.json" if selected_catalog else "source-runtimes.json"
    catalog,_=merge(json.loads((root/source_name).read_text()),target)
    payload=root/'unpack/payload';receipt=private_json(payload/'receipt.json');files=next(c['files']for c in receipt['components']if c['id']=='openwhisk-resources')
    manifest_item=next(f for f in files if f['path'].endswith('/openwhisk-export.json'));manifest=private_json(payload/'artifacts'/manifest_item['path'])
    def documents():
        for database in manifest['databases']:
            item=next(f for f in files if f['path'].endswith('/'+database['file']));path=regular(payload/'artifacts'/item['path'])
            require(digest(path)==item['sha256'],'runtime_inventory_artifact_changed')
            with path.open()as stream:
                for line in stream:
                    if line.strip():yield json.loads(line)
    required=required_runtime_images(catalog,documents());cached=run('offline-runtime-cache',['/usr/local/bin/k3s','ctr','-n','k8s.io','images','ls','-q']).decode().splitlines()
    missing=missing_runtime_images(required,cached)
    result={'requiredImages':required,'missingImages':missing,'allRequiredRuntimeImagesCached':not missing,'checkedBeforeNativeRestore':True}
    path=root/'offline-runtime-verification.json';path.write_text(json.dumps(result));path.chmod(0o600)
    require(not missing,'offline_runtime_image_closure_incomplete')
    return result
