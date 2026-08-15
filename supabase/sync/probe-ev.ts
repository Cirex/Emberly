import fs from "node:fs";
import { ResManClient } from "./src/resman/client";
import { resManConfigurationFromEnv, resManCredentialsFromEnv } from "./src/resman/config";
import { ResManScrapeHttp, mapWithConcurrency } from "./src/resman/scrapers/http";

const TR = /<tr\b[\s\S]*?<\/tr>/g;
const TD = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g;
const tmpl = (s: string) =>
  s.replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, "<date>").replace(/\$?\b\d[\d,]*\.\d{2}\b/g, "<amt>")
   .replace(/\b\d+\b/g, "<n>").replace(/\s+/g, " ").trim().slice(0, 92);

async function main() {
  const env = process.env;
  const client = new ResManClient(resManConfigurationFromEnv(env), {
    credentials: resManCredentialsFromEnv(env), connectionsPerHost: 5, log: () => {},
  });
  await client.ensureAuthenticated(resManCredentialsFromEnv(env));
  const http = new ResManScrapeHttp(client);
  const leases = JSON.parse(fs.readFileSync("/tmp/evict-leases.json", "utf8"));

  const all = new Map<string, { n: number; leases: Set<string> }>();
  const evictish: string[] = [];
  let withAny = 0, rowsTotal = 0, emptyLogs = 0;

  await mapWithConcurrency(leases, 5, async (l: any) => {
    const html = await http.getText(`/ActivityLog/ActivityLog?objectID=${l.resman_lease_id}`);
    const rows = [...html.matchAll(TR)].map((m) =>
      [...m[0].matchAll(TD)].map((c) => c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
    ).filter((c) => c.length >= 2 && !/^Timestamp$/i.test(c[0]));
    if (rows.length === 0) emptyLogs++;
    rowsTotal += rows.length;
    let hit = false;
    for (const r of rows) {
      const k = tmpl(r[1]);
      const e = all.get(k) ?? { n: 0, leases: new Set<string>() };
      e.n++; e.leases.add(l.resman_lease_id); all.set(k, e);
      if (/evict|writ|court|fed\b|detainer|lock ?out|judg|legal|attorney|notice to vacate|ntv/i.test(r[1])) {
        hit = true;
        evictish.push(`${l.status.padEnd(15)} ${l.unit_number.padEnd(11)} ${r[0]}  ${r[1].slice(0, 95)}`);
      }
    }
    if (hit) withAny++;
  });

  console.log(`${leases.length} eviction leases · ${rowsTotal} log rows · ${emptyLogs} empty logs`);
  console.log(`leases with ANY eviction/court/legal-shaped line: ${withAny}/${leases.length}\n`);
  console.log("=== matching lines ===");
  for (const line of evictish.slice(0, 30)) console.log("  " + line);
  console.log("\n=== most common events on eviction leases ===");
  for (const [k, v] of [...all].sort((a, b) => b[1].leases.size - a[1].leases.size).slice(0, 18)) {
    console.log(`  ${String(v.leases.size).padStart(3)} leases  ${k}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
