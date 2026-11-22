
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

const rootDir = path.resolve(currentDir, "../..");
const outputDir = path.resolve(rootDir, "android-app/www");

// Files that belong to the backend or development environment.
const excludedDirectories = new Set([
  ".git",
  "node_modules",
  "android-app",
  "config",
  "database",
  "routes",
  "workers",
  "tests",
  "coverage",
  "dist",
  "build"
]);

// Only copy browser-side files.
const allowedExtensions = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf"
]);

let copiedFiles = 0;
let skippedFiles = 0;

function shouldSkipFile(filePath, extension) {
  const name = path.basename(filePath).toLowerCase();

  if (name === ".env" || name.startsWith(".env.")) {
    return true;
  }

  if (
    name === "server.js" ||
    name === "package.json" ||
    name === "package-lock.json" ||
    name === "capacitor.config.json"
  ) {
    return true;
  }

  // Keep the Android-specific Splash Screen.
  const relativePath = path.relative(rootDir, filePath);

  if (relativePath === "index.html") {
    return true;
  }

  return !allowedExtensions.has(extension);
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

    if (shouldSkipFile(sourcePath, extension)) {
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

  fs.mkdirSync(outputDir, {
    recursive: true
  });

  console.log("Preparing RUBALIA Android frontend...");
  console.log("Source:", rootDir);
  console.log("Destination:", outputDir);

  copyFrontend(rootDir);

  console.log("--------------------------------");
  console.log("Frontend preparation completed.");
  console.log("Files copied:", copiedFiles);
  console.log("Files skipped:", skippedFiles);
  console.log("--------------------------------");

  if (copiedFiles === 0) {
    throw new Error("No frontend files were copied.");
  }

} catch (error) {
  console.error("Frontend preparation failed:");
  console.error(error.message);
  process.exitCode = 1;
}
