import { readFile } from "node:fs/promises";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { z } from "zod";
import type { ConnectorDistribution } from "../../licensing-worker/src/connector/routes.js";

const Manifest = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(536870912), url: z.string().url(), signature: z.string().min(100).max(1024), production: z.boolean() }).strict();

/** Only tiny release metadata lives on the portal. Binary bytes never flow through this host. */
export function connectorDistribution(config: NodeJS.ProcessEnv): ConnectorDistribution | undefined {
  if (config["CONNECTOR_ENABLED"] !== "1") return undefined;
  const cdn = config["CONNECTOR_CDN_URL"], manifestFile = config["CONNECTOR_MANIFEST_FILE"], keyId = config["CONNECTOR_CDN_KEY_ID"], parameter = config["CONNECTOR_CDN_KEY_PARAMETER"];
  if (!cdn || !/^https:\/\/[a-z0-9-]+\.cloudfront\.net$/.test(cdn) || !manifestFile || !keyId || !parameter) throw new Error("Incomplete connector distribution configuration");
  const ssm = new SSMClient({ region: config["AWS_REGION"] ?? "us-east-2", maxAttempts: 3 });
  let cached: { expiresAt: number; key: Promise<string> } | null = null;
  const signingKey = () => {
    if (!cached || cached.expiresAt <= Date.now()) {
      const entry = { expiresAt: Date.now()+300_000, key: ssm.send(new GetParameterCommand({ Name: parameter, WithDecryption: true })).then((r) => {
        if (!r.Parameter?.Value) throw new Error("Connector CDN key unavailable");
        return r.Parameter.Value;
      }) };
      entry.key.catch(() => { if (cached === entry) cached = null; }); cached = entry;
    }
    return cached.key;
  };
  return {
    enabled: true,
    async manifest() {
      const value = Manifest.parse(JSON.parse(await readFile(manifestFile,"utf8")));
      if (!value.production || value.url !== `${cdn}/runtime/connector-${value.version}.zip`) throw new Error("Only an approved production release can be distributed");
      return value;
    },
    async stubUrl(version,filename,expiresAt) {
      const url = new URL(`${cdn}/stub/stub-${version}.exe`);
      url.searchParams.set("response-content-disposition",`attachment; filename="${filename}"`);
      return getSignedUrl({ url: url.href, keyPairId: keyId, privateKey: await signingKey(), dateLessThan: new Date(expiresAt).toISOString() });
    },
  };
}
