import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const definition = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, "../setup/kubernetes/crds/whisk-crd.yaml"), "utf8")) as any;
const fields = definition.spec.versions.find((v: any) => v.name === "v1").schema.openAPIV3Schema.properties.spec.properties;

test("the installation CRD retains the restored backend options", () => {
  expect(fields.redis.properties["acl-persistence-enabled"].type).toBe("boolean");
  const metadata = fields.milvus.properties.etcd.properties;
  const objects = fields.milvus.properties.storage.properties;
  for (const field of [metadata["root-path"], objects["root-path"], metadata.username]) {
    expect(field.type).toBe("string");
    const pattern = new RegExp(field.pattern);
    expect(pattern.test("restored_native_0123")).toBe(true);
    expect(pattern.test("../source")).toBe(false);
    expect(pattern.test("value\nother")).toBe(false);
  }
});
