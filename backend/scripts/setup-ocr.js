import "dotenv/config";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readOcrConfig } from "../src/ocr/config.js";

// One-time developer provisioning. The runtime OCR worker never downloads models.
const directory = readOcrConfig().languageDataPath ?? resolve("../.local/tessdata");
await mkdir(directory, { recursive: true });
for (const language of ["eng", "ind"]) {
  const target = join(directory, `${language}.traineddata`);
  try {
    await access(target);
    console.log(`${language}.traineddata already available.`);
    continue;
  } catch { /* Download only missing language data. */ }
  const temporary = `${target}.partial`;
  try {
    const response = await fetch(`https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/${language}.traineddata`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error("MODEL_DOWNLOAD_FAILED");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1_000_000 || bytes.length > 30_000_000) throw new Error("INVALID_MODEL_DOWNLOAD");
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, target);
    console.log(`${language}.traineddata installed.`);
  } catch {
    await rm(temporary, { force: true });
    console.error(`Failed to install ${language}.traineddata. Check connectivity to tesseract-ocr/tessdata_best and local write permissions.`);
    process.exitCode = 1;
    break;
  }
}
