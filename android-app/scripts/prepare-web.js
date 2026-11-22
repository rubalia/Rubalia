import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

const rootDir = path.resolve(currentDir, "../..");
const outputDir = path.join(rootDir, "android-app", "www");

const excludedDirectories = new Set([
  ".git",
  ".github",
  "node_modules",
  "android-app",
  "config",
  "database",
  "routes",
  "workers",
  "tests",
  "coverage",
  "uploads",
  "logs"
]);

const allowedExtensions = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".webmanifest",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".gif",
  ".svg",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp4",
  ".webm",
  ".mp3",
  ".ogg"
]);

const excludedFiles = new Set([
  "server.js",
  "package.json",
  "package-lock.json",
  "capacitor.config.json",
  "yarn.lock",
  "pnpm-lock.yaml"
]);

let copiedFiles = 0;
let skippedFiles = 0;

function isExcludedFile(filePath, extension) {
  const name = path.basename(filePath).toLowerCase();
  const relativePath = path.relative(rootDir, filePath);

  if (name === ".env" || name.startsWith(".env.")) {
    return true;
  }

  if (excludedFiles.has(name)) {
    return true;
  }

  if (name.endsWith(".sql") || name.endsWith(".pem")) {
    return true;
  }

  // Keep the Android-specific splash screen.
  if (relativePath === "index.html") {
    return true;
  }

  return !allowedExtensions.has(extension);
}

function cleanOutputDirectory() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    return;
  }

  const entries = fs.readdirSync(outputDir);

  for (const entry of entries) {
    // Preserve Android's custom splash screen.
    if (entry === "index.html") {
      continue;
    }

    fs.rmSync(path.join(outputDir, entry), {
      recursive: true,
      force: true
    });
  }
}

function copyFrontend(sourceDir) {
  const entries = fs.readdirSync(sourceDir, {
    withFileTypes: true
  });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);

    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) {
        continue;
      }

      copyFrontend(sourcePath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();

    if (isExcludedFile(sourcePath, extension)) {
      skippedFiles++;
      continue;
    }

    const relativePath = path.relative(rootDir, sourcePath);
    const destinationPath = path.join(outputDir, relativePath);

    fs.mkdirSync(path.dirname(destinationPath), {
      recursive: true
    });

    fs.copyFileSync(sourcePath, destinationPath);

    copiedFiles++;

    console.log("Copied:", relativePath);
  }
}

try {
  if (!fs.existsSync(rootDir)) {
    throw new Error("Repository root directory was not found.");
  }

  const splashPath = path.join(outputDir, "index.html");

  if (!fs.existsSync(splashPath)) {
    throw new Error(
      "Android splash screen is missing: android-app/www/index.html"
    );
  }

  console.log("Preparing RUBALIA Android frontend...");

  cleanOutputDirectory();

  copyFrontend(rootDir);

  console.log("--------------------------------");
  console.log("Frontend preparation completed.");
  console.log("Files copied:", copiedFiles);
  console.log("Files skipped:", skippedFiles);
  console.log("Splash screen preserved.");
  console.log("--------------------------------");

  if (copiedFiles === 0) {
    throw new Error("No frontend files were copied.");
  }

} catch (error) {
  console.error("Frontend preparation failed:");
  console.error(error.message);
  process.exitCode = 1;
}
