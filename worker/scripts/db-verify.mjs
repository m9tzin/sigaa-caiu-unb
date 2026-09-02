#!/usr/bin/env node
// Fails when the database does not match schema.sql.
//
//   npm run db:verify          # the remote database
//   npm run db:verify:local    # the local one wrangler dev uses
//
// Why this exists: schema.sql and the schema_migration_*.sql files are only applied
// by someone remembering to run "wrangler d1 execute --remote --file=...". Nothing
// downstream notices when that does not happen. It already did not happen once --
// the partial indexes in schema_migration_cache_indexes.sql sat in the repo, reviewed
// and committed, while the database ran without them, and the only symptom was a
// query reading every row of checks on requests that should have read one. The repo
// said one thing, the database said another, and no part of the system could tell.
//
// So this compares the two and exits non-zero on drift. Wired into the deploy
// workflow ahead of "wrangler deploy", it turns that silence into a failed build.
//
// It compares definitions, not just names: sqlite_master stores the original DDL with
// only "IF NOT EXISTS" removed, so an index that exists under the right name but on
// the wrong columns -- or with a different partial-index WHERE clause -- is caught too.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const local = process.argv.includes("--local");

/** Statements we know how to compare. Anything else in schema.sql is ignored. */
const CREATE = /^CREATE\s+(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i;

/**
 * sqlite_master strips "IF NOT EXISTS" and keeps everything else verbatim -- including
 * any "--" comment written inside the statement, which schema.sql has in the middle of
 * CREATE TABLE checks. Both sides therefore get the same reduction, and line comments
 * have to go before whitespace is collapsed: afterwards a "--" would swallow the rest
 * of the statement instead of the rest of its line.
 */
function normalize(sql) {
  return sql
    .split("\n")
    .map(line => line.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\bIF\s+NOT\s+EXISTS\s+/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .trim();
}

/**
 * Parses schema.sql into name -> normalized DDL.
 *
 * Line comments go first, then statements split on ";". That split is only safe
 * because no string literal in this schema contains a semicolon; if one ever does,
 * this needs a real tokenizer rather than a regex.
 */
function declaredObjects() {
  const raw = readFileSync(join(workerDir, "schema.sql"), "utf8");
  const withoutComments = raw
    .split("\n")
    .map(line => line.replace(/--.*$/, ""))
    .join("\n");

  const objects = new Map();
  for (const statement of withoutComments.split(";")) {
    const trimmed = statement.trim();
    const match = CREATE.exec(trimmed);
    if (match) objects.set(match[2], { kind: match[1].toUpperCase(), sql: normalize(trimmed) });
  }
  return objects;
}

function databaseName() {
  // wrangler.jsonc is JSON with comments in principle; this one is plain JSON, and a
  // regex keeps the script dependency-free either way.
  const raw = readFileSync(join(workerDir, "wrangler.jsonc"), "utf8");
  const match = /"database_name"\s*:\s*"([^"]+)"/.exec(raw);
  if (!match) throw new Error("database_name nao encontrado em wrangler.jsonc");
  return match[1];
}

function liveObjects(db) {
  const args = [
    "wrangler", "d1", "execute", db,
    local ? "--local" : "--remote",
    "--json",
    "--command",
    "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
  ];

  let stdout;
  try {
    stdout = execFileSync("npx", args, { cwd: workerDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // wrangler splits its output between the two streams depending on what went wrong,
    // and an auth failure can land entirely on stdout -- so print both, or the failure
    // is unreadable in CI.
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    console.error("erro ao consultar o banco:");
    console.error(`  comando: npx ${args.join(" ")}`);
    console.error(`  status:  ${error.status ?? "?"}`);
    if (output.trim()) console.error(output);
    else console.error(`  ${error.message}`);

    // The token a deploy needs and the token this check needs are not the same. A
    // token scoped only to Workers Scripts:Edit deploys fine and cannot read D1, which
    // surfaces as 7403 rather than as anything mentioning permissions.
    if (/\b7403\b|not authorized to access this service/i.test(output)) {
      console.error(
        "\nO token nao tem acesso a D1. Em Cloudflare > My Profile > API Tokens,\n" +
        "adicione a permissao 'D1:Read' (ou 'D1:Edit') ao token usado aqui.\n" +
        "Deploy de Worker e leitura de D1 sao permissoes distintas: o token pode\n" +
        "publicar o worker e ainda assim nao conseguir consultar o banco.\n"
      );
    }

    // Exit 2 means "could not check", which the caller must not confuse with exit 1,
    // "checked and found drift". The workflow blocks on the second and warns on the
    // first: a permissions gap should not take deployment down with it.
    process.exit(2);
  }

  // wrangler prints banners before the JSON payload.
  const start = stdout.indexOf("[");
  if (start === -1) {
    console.error("resposta do wrangler sem JSON:\n" + stdout);
    process.exit(2);
  }

  const objects = new Map();
  for (const row of JSON.parse(stdout.slice(start))[0].results) {
    objects.set(row.name, normalize(row.sql));
  }
  return objects;
}

const db = databaseName();
const declared = declaredObjects();
const live = liveObjects(db);

const missing = [];
const different = [];
for (const [name, { kind, sql }] of declared) {
  const liveSql = live.get(name);
  if (liveSql === undefined) missing.push(`${kind} ${name}`);
  else if (liveSql !== sql) different.push({ name, expected: sql, actual: liveSql });
}
// Objects the database has and schema.sql does not describe. Reported, never fatal:
// a dropped declaration or a hand-made index is a question for a human, not a reason
// to block a deploy. D1 keeps its own bookkeeping tables in here; those are not ours
// to describe.
const extra = [...live.keys()].filter(name => !declared.has(name) && !name.startsWith("_cf_"));

const target = local ? "local" : "remoto";
console.log(`\nschema.sql x banco ${target} (${db})`);
console.log(`  declarados: ${declared.size}   no banco: ${live.size}\n`);

for (const item of missing) console.log(`  FALTA      ${item}`);
for (const { name, expected, actual } of different) {
  console.log(`  DIFERE     ${name}`);
  console.log(`    schema.sql: ${expected}`);
  console.log(`    banco:      ${actual}`);
}
for (const name of extra) console.log(`  extra      ${name} (no banco, ausente do schema.sql)`);

if (missing.length === 0 && different.length === 0) {
  const suffix = extra.length ? `, ${extra.length} extra(s) apenas informativo(s)` : "";
  console.log(`  tudo em dia${suffix}\n`);
  process.exit(0);
}

console.log(
  `\n${missing.length} faltando, ${different.length} divergente(s).\n` +
  `Aplique o schema com:  npm run db:${local ? "local" : "remote"}\n` +
  `schema.sql e idempotente (tudo IF NOT EXISTS), entao e seguro re-executar.\n` +
  `Colunas novas continuam vindo dos schema_migration_*.sql, que CREATE TABLE nao aplica\n` +
  `a uma tabela que ja existe.\n`
);
process.exit(1);
