import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "dotenv";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { hashPassword } from "../src/auth/passwords.js";
import { createAuthRepository } from "../src/repositories/authRepository.js";
import { createLocalFileStorage } from "../src/storage/localFileStorage.js";

const backend = fileURLToPath(new URL("..", import.meta.url));
const root = dirname(backend);
const local = join(root, ".local");
const data = join(local, "postgres");
const credentialPath = join(local, "development.json");
const mode = process.argv[2] ?? "start";

async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: backend, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Development command failed (${code}): ${args[0] ?? command}`)));
  });
}

async function main() {
  if (!["setup", "start", "db", "stop"].includes(mode)) throw new Error("Use setup, start, db, or stop");
  if (process.env.NODE_ENV === "production") throw new Error("Local development is unavailable in production");
  await mkdir(local, { recursive: true });
  const nativeRequire = createRequire(import.meta.resolve("embedded-postgres"));
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const native = await import(pathToFileURL(nativeRequire.resolve(`@embedded-postgres/${platform}-${process.arch}`)).href);
  const control = (...args) => execute(native.pg_ctl, ["-D", data, ...args]);
  if (mode === "stop") {
    await control("stop", "-m", "fast", "-w");
    return;
  }

  let credentials;
  if (await exists(credentialPath)) credentials = JSON.parse(await readFile(credentialPath, "utf8"));
  else {
    // Never replace an existing project environment with a different database.
    if (await exists(join(backend, ".env"))) throw new Error("backend/.env already exists. Use the database configured there, or move it yourself before setup:local.");
    credentials = { port: 55432, databasePassword: randomBytes(24).toString("hex"), adminEmail: "admin@danaterang.local", adminPassword: randomBytes(24).toString("base64url") };
    await writeFile(credentialPath, JSON.stringify(credentials, null, 2), { flag: "wx", mode: 0o600 });
  }
  const databaseUrl = `postgres://danaterang_dev:${credentials.databasePassword}@127.0.0.1:${credentials.port}/danaterang`;
  const envPath = join(backend, ".env");
  if (!(await exists(envPath))) {
    const example = await readFile(join(backend, ".env.example"), "utf8");
    const content = example.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${databaseUrl}`)
      .replace(/^BOOTSTRAP_ADMIN_NAME=.*$/m, "BOOTSTRAP_ADMIN_NAME=Local Admin")
      .replace(/^BOOTSTRAP_ADMIN_EMAIL=.*$/m, `BOOTSTRAP_ADMIN_EMAIL=${credentials.adminEmail}`)
      .replace(/^BOOTSTRAP_ADMIN_PASSWORD=.*$/m, `BOOTSTRAP_ADMIN_PASSWORD=${credentials.adminPassword}`);
    await writeFile(envPath, content, { flag: "wx", mode: 0o600 });
  }
  const env = parse(await readFile(envPath));
  if (env.DATABASE_URL !== databaseUrl) throw new Error("backend/.env uses a different database. Start it with dev:api and dev:web; local setup has preserved the file.");
  if (!(await exists(join(data, "PG_VERSION")))) {
    await mkdir(data, { recursive: true });
    const passwordFile = join(local, "postgres-password.tmp");
    try {
      await writeFile(passwordFile, credentials.databasePassword, { mode: 0o600, flag: "wx" });
      await execute(native.initdb, ["-D", data, "--username=danaterang_dev", "--auth=scram-sha-256", `--pwfile=${passwordFile}`, "--encoding=UTF8", "--locale=C"]);
    } finally { await rm(passwordFile, { force: true }); }
  }

  const status = await new Promise((resolve, reject) => {
    const child = spawn(native.pg_ctl, ["-D", data, "status"], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  if (status !== 0) await control("-l", join(local, "postgres.log"), "-o", `-h 127.0.0.1 -p ${credentials.port}`, "start", "-w");
  if (mode === "db") {
    console.log(`Local PostgreSQL running on 127.0.0.1:${credentials.port}. Stop with npm run db:stop:local.`);
    return;
  }

  const children = [];
  let closing;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      await Promise.all(children.map((child) => new Promise((resolve) => {
        if (child.exitCode !== null || !child.pid) return resolve();
        child.once("exit", resolve);
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          killer.once("error", resolve);
        } else child.kill("SIGTERM");
      })));
      if (status !== 0) await control("stop", "-m", "fast", "-w");
    })();
    return closing;
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void close().catch(() => { process.exitCode = 1; }); });
  try {
    const adminPool = createPool(databaseUrl.replace(/\/danaterang$/, "/postgres"));
    try {
      if (!(await adminPool.query("SELECT 1 FROM pg_database WHERE datname = 'danaterang'")).rowCount) await adminPool.query("CREATE DATABASE danaterang");
    } finally { await adminPool.end(); }
    const pool = createPool(databaseUrl);
    try {
      console.log(`Applied ${(await runMigrations(pool)).length} local migration(s).`);
      const repository = createAuthRepository(pool);
      const admins = await pool.query("SELECT 1 FROM users WHERE role = 'ADMIN' LIMIT 1");
      if (!admins.rowCount) await repository.createFirstAdmin({ name: env.BOOTSTRAP_ADMIN_NAME, email: env.BOOTSTRAP_ADMIN_EMAIL, passwordHash: await hashPassword(env.BOOTSTRAP_ADMIN_PASSWORD) });
    } finally { await pool.end(); }
    if (!env.STORAGE_MODE || env.STORAGE_MODE === "local") await createLocalFileStorage({ root: resolve(backend, env.LOCAL_OBJECT_STORAGE_ROOT || "../.local/evidence") }).initialize();
    await execute(process.execPath, [join(backend, "scripts", "setup-ocr.js")]);
    console.log(`Local Admin: ${credentials.adminEmail}. Password is stored in .local/development.json and backend/.env.`);
    if (mode === "setup") return;
    const web = join(root, "frontend");
    const nextRequire = createRequire(join(web, "package.json"));
    const next = join(dirname(nextRequire.resolve("next/package.json")), "dist", "bin", "next");
    const apiChild = spawn(process.execPath, [join(backend, "src", "server.js")], { cwd: backend, stdio: "inherit" });
    children.push(apiChild);
    const webChild = spawn(process.execPath, [next, "dev", "--hostname", "localhost", "--port", "3000"], { cwd: web, stdio: "inherit" });
    children.push(webChild);
    console.log("Open http://localhost:3000. Ctrl+C stops the app and its local database.");
    await Promise.race(children.map((child) => new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => closing || code === 0 ? resolve() : reject(new Error(`Development server exited (${code})`)));
    })));
  } finally { await close(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
