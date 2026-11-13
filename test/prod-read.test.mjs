// scripts/prod-read/read.mjs against fake railway and vercel binaries first on PATH, in a throwaway repo with a task
// worktree: the argv each command builds, that provider CLIs run in the main checkout, variable names without values,
// the redactor and the output cap, and usage errors. No network, no real CLI.
//   node --test test/prod-read.test.mjs
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cap, redact } from "../scripts/prod-read/read.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/prod-read/read.mjs", import.meta.url));

const PEM_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj\n-----END PRIVATE KEY-----`;
const DB_PASS = "hunter2pass";
const TOKEN = "tok_9f8e7d6c5b4a";
const SECRETS = [PEM_BODY, "BEGIN PRIVATE KEY", DB_PASS, TOKEN];

const PROD = {
  services: [
    { name: "api", provider: "railway", service: "throu-api" },
    { name: "web", provider: "vercel", project: "throu-web", dir: "frontend" },
    {
      name: "worker",
      provider: "command",
      status: "echo worker up; pwd -P",
      logs: "cat \"$FAKE_DIR/logs.txt\"",
      vars: "printf 'FOO_TOKEN=abc123secretvalue\\nBAR_URL postgres://u:hunter2pass@h/db\\nexport BAZ=1\\nQUX: v\\nALONE\\n  \"cont\": 1\\n=odd\\n'",
    },
  ],
  errors: { provider: "sentry", org: "acme", project: "throu-api" },
  database: { readOnly: `postgres://reader:${DB_PASS}@db.example.com/app`, notes: "read replica" },
  notes: "api on Railway, web on Vercel",
};

const RAILWAY = `#!/usr/bin/env bash
{ echo "@@call"; echo "cwd=$(pwd -P)"; printf '%s\\n' "$@"; } >> "$FAKE_DIR/railway.calls"
if [ -n "$FAKE_FAIL" ]; then echo "error: unauthorized, token=$FAKE_FAIL" >&2; exit 1; fi
case "$1 $2" in
  "service status") echo '{"id":"svc-1","status":"SUCCESS","latestDeployment":{"id":"dep-1","status":"SUCCESS","createdAt":"2026-11-12T10:00:00Z"}}' ;;
  "deployment list") echo '[{"id":"dep-1","status":"SUCCESS","createdAt":"2026-11-12T10:00:00Z","meta":{"commitMessage":"fix login\\nmore"}},{"id":"dep-0","status":"REMOVED","createdAt":"2026-11-11T10:00:00Z"}]' ;;
  "variable list") if [ -n "$FAKE_VARS_TEXT" ]; then cat "$FAKE_DIR/vars.txt"; else cat "$FAKE_DIR/vars.json"; fi ;;
  logs*) cat "$FAKE_DIR/logs.txt" ;;
  *) echo "fake railway: unexpected $*" >&2; exit 2 ;;
esac
`;

const VERCEL = `#!/usr/bin/env bash
{ echo "@@call"; echo "cwd=$(pwd -P)"; printf '%s\\n' "$@"; } >> "$FAKE_DIR/vercel.calls"
case "$1" in
  ls) echo '{"deployments":[{"uid":"dpl_1","url":"throu-web-abc.vercel.app","state":"READY","created":1762941600000},{"uid":"dpl_0","url":"throu-web-old.vercel.app","state":"ERROR","created":1762855200000}]}' ;;
  logs) echo "vercel log line" ;;
  env) cat "$FAKE_DIR/vercel-env.json" ;;
  *) echo "fake vercel: unexpected $*" >&2; exit 2 ;;
esac
`;

/** Run a process to its end without blocking the event loop, so the tests run side by side. */
function exec(cmd, args, opts) {
  return new Promise((done) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    p.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
    p.on("close", (status) => done({ status, stdout, stderr }));
  });
}

/** A repo whose main checkout holds the manifest, a task worktree inside it, and fake CLIs on PATH. */
async function world(t, production = PROD) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prod-read-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, "main");
  mkdirSync(join(main, ".claude"), { recursive: true });
  mkdirSync(join(main, "frontend"));
  writeFileSync(join(main, "frontend", "index.js"), "\n");
  writeFileSync(join(main, ".claude", "test-manifest.json"), JSON.stringify({ stacks: [], ...(production ? { production } : {}) }, null, 2));
  const git = async (...a) => {
    const r = await exec("git", ["-C", main, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {});
    assert.equal(r.status, 0, r.stderr);
  };
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-qm", "init");
  const wt = join(main, ".claude", "worktrees", "task");
  await git("worktree", "add", "-q", wt, "-b", "feat/task");

  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, text] of [["railway", RAILWAY], ["vercel", VERCEL]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(root, "vars.json"), JSON.stringify({ PRIVATE_KEY: PEM, DATABASE_URL: `postgres://app:${DB_PASS}@db.internal:5432/app`, API_TOKEN: TOKEN }, null, 2));
  writeFileSync(join(root, "vars.txt"), `API_TOKEN ${TOKEN}\nDATABASE_URL postgres://app:${DB_PASS}@db/app\n`);
  writeFileSync(join(root, "vercel-env.json"), JSON.stringify({ envs: [{ key: "NEXT_PUBLIC_URL", value: "https://x" }, { key: "AUTH_SECRET", value: TOKEN }] }));
  writeFileSync(join(root, "logs.txt"), "app started\n");

  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, FAKE_DIR: root };
  const run = (args, extra = {}, cwd = wt) => exec(process.execPath, [SCRIPT, ...args], { cwd, env: { ...env, ...extra } });
  const calls = (name) => {
    const f = join(root, `${name}.calls`);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("@@call\n").filter(Boolean).map((block) => {
      const lines = block.replace(/\n$/, "").split("\n");
      return { cwd: lines[0].slice(4), argv: lines.slice(1) };
    });
  };
  return { root, main, wt, run, calls };
}

const noSecrets = (r) => {
  for (const s of SECRETS) {
    assert.ok(!r.stdout.includes(s), `stdout leaks ${s}`);
    assert.ok(!r.stderr.includes(s), `stderr leaks ${s}`);
  }
};

describe("prod-read", { concurrency: true }, () => {
  test("services lists each service and the agent's fields, with no CLI calls", async (t) => {
    const w = await world(t);
    const r = await w.run(["services"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^api {2}railway {2}service=throu-api {2}environment=production$/m);
    assert.match(r.stdout, /^web {2}vercel {2}project=throu-web {2}environment=production {2}dir=frontend$/m);
    assert.match(r.stdout, /^worker {2}command {2}status, logs, vars$/m);
    assert.match(r.stdout, /^errors: \{"provider":"sentry","org":"acme","project":"throu-api"\}$/m);
    assert.match(r.stdout, /postgres:\/\/\[redacted\]@db\.example\.com\/app/);
    assert.match(r.stdout, /^notes: api on Railway, web on Vercel$/m);
    noSecrets(r);
    assert.deepEqual(w.calls("railway"), []);
    assert.deepEqual(w.calls("vercel"), []);
  });

  test("railway status runs fixed argv in the main checkout and prints a summary", async (t) => {
    const w = await world(t);
    const r = await w.run(["status", "api"]);
    assert.equal(r.status, 0, r.stderr);
    const c = w.calls("railway");
    assert.deepEqual(c.map((x) => x.argv), [
      ["service", "status", "-s", "throu-api", "-e", "production", "--json"],
      ["deployment", "list", "-s", "throu-api", "-e", "production", "--limit", "5", "--json"],
    ]);
    for (const x of c) assert.equal(x.cwd, w.main);
    assert.notEqual(w.main, w.wt);
    assert.match(r.stdout, /status=SUCCESS {2}id=svc-1/);
    assert.match(r.stdout, /^ {2}id=dep-1 {2}status=SUCCESS {2}created=2026-11-12T10:00:00Z {2}message=fix login$/m);
    assert.match(r.stdout, /^ {2}id=dep-0 {2}status=REMOVED/m);
    assert.ok(!r.stdout.includes("{"), "no raw JSON");
  });

  test("status with no service covers every provider; vercel runs in the service's dir", async (t) => {
    const w = await world(t);
    const r = await w.run(["status"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(w.calls("railway").length, 2);
    const [v] = w.calls("vercel");
    assert.deepEqual(v.argv, ["ls", "throu-web", "--environment", "production", "-F", "json", "--non-interactive"]);
    assert.equal(v.cwd, join(w.main, "frontend"));
    assert.match(r.stdout, /id=dpl_1 {2}status=READY {2}created=2025-11-12T10:00:00\.000Z {2}url=throu-web-abc\.vercel\.app/);
    assert.match(r.stdout, /^== worker {2}command/m);
    assert.match(r.stdout, /^worker up$/m);
    assert.ok(r.stdout.includes(`\n${w.main}\n`) || r.stdout.endsWith(`${w.main}\n`), `command services run in the main checkout:\n${r.stdout}`);
  });

  test("deploys takes --limit and refuses one past 50", async (t) => {
    const w = await world(t);
    const r = await w.run(["deploys", "api", "--limit", "20"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(w.calls("railway")[0].argv, ["deployment", "list", "-s", "throu-api", "-e", "production", "--limit", "20", "--json"]);
    assert.equal(r.stdout.trim().split("\n").length, 2);
    assert.equal((await w.run(["deploys", "api", "--limit", "51"])).status, 3);
    const v = await w.run(["deploys", "web", "--limit", "1"]);
    assert.equal(v.status, 0, v.stderr);
    assert.equal(v.stdout.trim().split("\n").length, 1);
  });

  test("railway logs always pass --lines; --errors adds or ANDs a level filter", async (t) => {
    const w = await world(t);
    assert.equal((await w.run(["logs", "api"])).status, 0);
    assert.equal((await w.run(["logs", "api", "--errors"])).status, 0);
    assert.equal((await w.run(["logs", "api", "--filter", "path:/login; rm -rf /", "--errors", "--since", "1h", "--lines", "50", "--http"])).status, 0);
    assert.equal((await w.run(["logs", "api", "--build", "--filter=-@level:info"])).status, 0);
    const base = ["logs", "-s", "throu-api", "-e", "production"];
    assert.deepEqual(w.calls("railway").map((x) => x.argv), [
      [...base, "--lines", "200"],
      [...base, "--lines", "200", "--filter=@level:error"],
      [...base, "--lines", "50", "--since=1h", "--filter=(path:/login; rm -rf /) AND @level:error", "--http"],
      [...base, "--lines", "200", "--filter=-@level:info", "--build"],
    ]);
    assert.equal((await w.run(["logs", "api", "--lines", "1001"])).status, 3);
    assert.equal((await w.run(["logs", "api", "--lines", "0"])).status, 3);
    assert.equal((await w.run(["logs", "api", "--follow"])).status, 3);
    assert.equal(w.calls("railway").length, 4, "refused calls never reach the CLI");
  });

  test("vercel logs argv", async (t) => {
    const w = await world(t);
    const r = await w.run(["logs", "web", "--since", "30m", "--filter", "status:500", "--errors", "--lines", "20"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "vercel log line\n");
    const [c] = w.calls("vercel");
    assert.deepEqual(c.argv, ["logs", "--project", "throu-web", "--environment", "production", "--no-follow", "--no-branch", "-n", "20", "--since=30m", "--query=status:500", "--level", "error", "--non-interactive"]);
    assert.equal(c.cwd, join(w.main, "frontend"));
    assert.equal((await w.run(["logs", "web", "--http"])).status, 3);
  });

  test("vars prints sorted names and never a value", async (t) => {
    const w = await world(t);
    const r = await w.run(["vars", "api"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "API_TOKEN\nDATABASE_URL\nPRIVATE_KEY\n");
    assert.equal(r.stderr, "");
    noSecrets(r);
    assert.deepEqual(w.calls("railway")[0].argv, ["variable", "list", "-s", "throu-api", "-e", "production", "--json"]);
    assert.equal(w.calls("railway")[0].cwd, w.main);

    const v = await w.run(["vars", "web"]);
    assert.equal(v.status, 0, v.stderr);
    assert.equal(v.stdout, "AUTH_SECRET\nNEXT_PUBLIC_URL\n");
    assert.ok(!v.stdout.includes(TOKEN));
    assert.deepEqual(w.calls("vercel")[0].argv, ["env", "ls", "production", "-F", "json", "--non-interactive"]);
  });

  test("vars output that is not JSON exits 1 and prints none of it", async (t) => {
    const w = await world(t);
    const r = await w.run(["vars", "api"], { FAKE_VARS_TEXT: "1" });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /could not be read as variable names/);
    assert.ok(!r.stderr.includes("API_TOKEN"));
    noSecrets(r);
  });

  test("a command service: status, logs and names-only vars", async (t) => {
    const w = await world(t);
    const s = await w.run(["status", "worker"]);
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stdout, /^worker up$/m);
    const v = await w.run(["vars", "worker"]);
    assert.equal(v.status, 0, v.stderr);
    assert.equal(v.stdout, "ALONE\nBAR_URL\nBAZ\nFOO_TOKEN\nQUX\n");
    assert.equal((await w.run(["logs", "worker", "--lines", "5"])).status, 3);
    assert.equal((await w.run(["deploys", "worker"])).status, 3);
  });

  test("logs pass the redactor: PEM block, credentialed URL, Bearer token, api_key", async (t) => {
    const w = await world(t);
    writeFileSync(join(w.root, "logs.txt"), [
      "boot ok",
      `loaded key ${PEM}`,
      `connecting to postgres://app:${DB_PASS}@db.internal:5432/app`,
      `GET /me Authorization: Bearer ${TOKEN}`,
      `retry with api_key=${TOKEN}&page=2`,
      "commit 3f2a9c1e5b7d8f0a1c2e4b6d8f0a2c4e6b8d0f1a",
      "",
    ].join("\n"));
    for (const svc of ["api", "worker"]) {
      const r = await w.run(["logs", svc]);
      assert.equal(r.status, 0, r.stderr);
      noSecrets(r);
      assert.match(r.stdout, /^boot ok$/m);
      assert.match(r.stdout, /loaded key \[redacted private key\]/);
      assert.match(r.stdout, /postgres:\/\/\[redacted\]@db\.internal:5432\/app/);
      assert.match(r.stdout, /Authorization: \[redacted\]/);
      assert.match(r.stdout, /api_key=\[redacted\]&page=2/);
      assert.match(r.stdout, /commit 3f2a9c1e5b7d8f0a1c2e4b6d8f0a2c4e6b8d0f1a/, "a lower-case hex SHA stays");
    }
  });

  test("redact: JSON pairs, Bearer alone, long mixed tokens, plain text", () => {
    assert.equal(redact('{"apiKey": "abc", "name": "x"}'), '{"apiKey": "[redacted]", "name": "x"}');
    assert.equal(redact('{"PRIVATE_KEY":"-----BEGIN RSA PRIVATE KEY-----\\nAAA\\n-----END RSA PRIVATE KEY-----"}'), '{"PRIVATE_KEY":"[redacted]"}');
    assert.equal(redact("curl -H 'x' Bearer eyJhbGc.eyJzdWIi.sig"), "curl -H 'x' Bearer [redacted]");
    assert.equal(redact("DB_PASSWORD=s3cr3t STRIPE_SECRET: 'sk'"), "DB_PASSWORD=[redacted] STRIPE_SECRET: [redacted]");
    assert.equal(redact(`id ${"sk_" + "live_"}51HxYzAbCdEfGhIjKlMnOpQrStUvWxYz0123456789 end`), "id [redacted] end");
    assert.equal(redact("https://user:pw@example.com/x and https://example.com:443/y"), "https://[redacted]@example.com/x and https://example.com:443/y");
    assert.equal(redact("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP end"), "jwt [redacted] end");
    for (const tok of ["sk_test_", "pk_live_", "rk_live_"].map((p) => p + "4eC39HqLyjWDarjtT1zdp7dc").concat(["ghp_" + "16C7e42F292c6912E7710c838347Ae178B4a", "github_pat_" + "11ABCDEFG0abcdefghij12_xyz", "xoxb-" + "123456789012-abcdefghij", "AKIA" + "IOSFODNN7EXAMPLE", "ASIA" + "IOSFODNN7EXAMPLE"])) {
      assert.equal(redact(`k ${tok} e`), "k [redacted] e", tok);
    }
    assert.equal(redact("task_test_runner ghp_short skip_live_x AKIA123"), "task_test_runner ghp_short skip_live_x AKIA123", "near-misses stay");
    assert.equal(redact("GET /healthz 200 in 12ms"), "GET /healthz 200 in 12ms");
    const path = "/private/var/folders/tb/8_r2b2n15w35y66lc25d77d00000gn/T/prod-read-AbC12x/Users-Projects-kesselrunner-plans-4-6/main";
    assert.equal(redact(path), path, "a long path of words and lower-case ids stays");
  });

  test("output is capped: long lines cut, only the last 400 lines kept", async (t) => {
    const w = await world(t);
    const lines = Array.from({ length: 449 }, (_, i) => `line ${i}`);
    lines.push("x".repeat(3000));
    writeFileSync(join(w.root, "logs.txt"), `${lines.join("\n")}\n`);
    const r = await w.run(["logs", "api"]);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.replace(/\n$/, "").split("\n");
    assert.equal(out.length, 401);
    assert.equal(out[0], "[50 earlier lines dropped; showing the last 400]");
    assert.equal(out[1], "line 50");
    assert.equal(out.at(-1), `${"x".repeat(2000)}...[cut]`);
    assert.equal(cap(""), "");
  });

  test("a failing provider command exits 1 with its stderr redacted and the argv named", async (t) => {
    const w = await world(t);
    const r = await w.run(["status", "api"], { FAKE_FAIL: TOKEN });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /error: unauthorized, token=\[redacted\]/);
    assert.match(r.stderr, /prod-read: command failed \(exit 1\): railway service status -s throu-api -e production --json/);
    noSecrets(r);
    const all = await w.run(["status"], { FAKE_FAIL: TOKEN });
    assert.equal(all.status, 1, "status of every service still reports the others");
    assert.match(all.stdout, /^worker up$/m);
  });

  test("usage errors exit 3", async (t) => {
    const w = await world(t);
    assert.equal((await w.run([])).status, 3);
    assert.equal((await w.run(["restart", "api"])).status, 3);
    assert.equal((await w.run(["status", "nope"])).status, 3);
    assert.match((await w.run(["status", "nope"])).stderr, /unknown service "nope" \(have: api, web, worker\)/);
    assert.equal((await w.run(["logs"])).status, 3);
    assert.equal((await w.run(["vars", "api", "extra"])).status, 3);
    assert.equal((await w.run(["status", "api", "--limit", "3"])).status, 3);
    assert.equal((await w.run(["services"], {}, w.root)).status, 3, "outside a git repo");
    const ok = await w.run(["services", "--repo", w.wt], {}, w.root);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(w.calls("railway").length, 0);

    const bare = await world(t, null);
    const r = await bare.run(["status"]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /no "production" block/);

    const odd = await world(t, { services: [{ name: "db", provider: "heroku" }] });
    assert.equal((await odd.run(["status", "db"])).status, 3);
    assert.match((await odd.run(["status"])).stderr, /unknown provider "heroku"/);
  });
});
