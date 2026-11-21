const requestAnnotation = "openserverless.org/enable-services";
const requestPath = "/metadata/annotations/openserverless.org~1enable-services";
type Service = "mongodb" | "milvus";
type Enablement = { requestId: string; tenantUid: string; services: Service[] };
type Tenant = {
  metadata: { name: string; uid: string; resourceVersion: string; deletionTimestamp?: string; annotations?: Record<string, string> };
  spec: { namespace: string } & Partial<Record<Service, { enabled: boolean }>>;
  status?: { serviceEnablement?: { requestId: string; state: string; reason?: string } };
};

function kubectl(args: string[]) {
  const result = Bun.spawnSync(["kubectl", "--request-timeout=15s", "-n", "openserverless", ...args],
    { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw Error("Could not read or update the tenant on the current OPS Engine.");
  return result.stdout.toString();
}

function tenant(name: string): Tenant {
  const value: Tenant = JSON.parse(kubectl(["get", "wsku", name, "-o", "json"]));
  if (value.metadata.name !== name || !value.metadata.uid || value.metadata.deletionTimestamp || value.spec.namespace !== name)
    throw Error("The tenant identity changed or removal is in progress.");
  return value;
}

function installed(value: Tenant, services: Service[]) {
  return services.every(service => value.spec[service]?.enabled === true);
}

async function enableServices(name: string, args: string[]) {
  if (!/^[a-z0-9]{5,61}$/.test(name)) throw Error("Enter an existing OPS tenant name.");
  const allowed: Service[] = ["mongodb", "milvus"];
  const services = allowed.filter(service => args.includes("--" + service + "=true"));
  if (!services.length) throw Error("Select --mongodb, --milvus or both.");

  const value = tenant(name);
  const uid = value.metadata.uid;
  const raw = value.metadata.annotations?.[requestAnnotation];
  const receipt = value.status?.serviceEnablement;
  let request: Enablement = { requestId: crypto.randomUUID(), tenantUid: uid, services };
  let expectedAnnotation: string | undefined;
  if (raw) {
    const prior: Enablement = JSON.parse(raw);
    if (prior.tenantUid !== uid || !Array.isArray(prior.services) || typeof prior.requestId !== "string")
      throw Error("The saved request belongs to another tenant identity or requires inspection.");
    const same = JSON.stringify(prior.services) === JSON.stringify(services);
    const recorded = receipt?.requestId === prior.requestId;
    if (same && recorded && receipt.state === "ready" && installed(value, services)) return;
    if (!recorded || !["ready", "refused"].includes(receipt.state)) {
      if (!same) throw Error("An earlier request is in progress. Check it with the original service selection.");
      request = prior;
      expectedAnnotation = raw;
    }
  }

  if (expectedAnnotation === undefined) {
    expectedAnnotation = JSON.stringify(request);
    const change = [
      { op: "test", path: "/metadata/uid", value: uid },
      { op: "test", path: "/metadata/resourceVersion", value: value.metadata.resourceVersion },
      value.metadata.annotations
        ? { op: "add", path: requestPath, value: expectedAnnotation }
        : { op: "add", path: "/metadata/annotations", value: { [requestAnnotation]: expectedAnnotation } },
    ];
    kubectl(["patch", "wsku", name, "--type=json", "-p", JSON.stringify(change)]);
  }

  const until = performance.now() + 180_000;
  while (performance.now() < until) {
    const latest = tenant(name);
    if (latest.metadata.uid !== uid || latest.metadata.annotations?.[requestAnnotation] !== expectedAnnotation)
      throw Error("The tenant or its original service request changed.");
    const status = latest.status?.serviceEnablement;
    if (status?.requestId === request.requestId) {
      if (status.state === "ready" && installed(latest, services)) return;
      if (status.state === "refused") throw Error("The Operator refused enablement. Check the tenant and whether its services are available.");
    }
    await Bun.sleep(1500);
  }
  throw Error("The Operator has not confirmed enablement. Run the same command to check the original request.");
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  try {
    const name = Bun.env.OPS_ENABLE_TENANT ?? "";
    await enableServices(name, args);
    console.log("Tenant services enabled.");
  } catch (error) {
    console.error(error instanceof Error && !(error instanceof SyntaxError) ? error.message : "Could not validate the original tenant request.");
    process.exitCode = 1;
  }
}
