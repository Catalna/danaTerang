import "dotenv/config";
import { spawn } from "node:child_process";

if (!process.env.DATABASE_URL) {
  console.error("Configure DATABASE_URL and start PostgreSQL before test:native.");
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ["--test", "test/mvp/workflow.test.js", "test/payments/routes.test.js"], {
    stdio: "inherit", env: { ...process.env, NATIVE_TEST_DATABASE_URL: process.env.DATABASE_URL, MVP_REAL_OCR: "true" },
  });
  child.once("error", () => { process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}
