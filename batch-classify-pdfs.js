#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");

const VALID_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "Figure",
  "Table",
  "TD",
  "TR",
  "TH",
  "Span",
  "LBody",
]);

const DEFAULT_OPTIONS = {
  move: true,
  recursive: false,
  taggedFolderName: "TAGGED",
  untaggedFolderName: "UNTAGGED",
};

function printUsage() {
  console.log(`Usage:
  node batch-classify-pdfs.js <input-folder> [options]

Options:
  --copy              Copy PDFs instead of moving them.
  --recursive         Process PDFs in nested folders.
  --tagged <name>     Output folder name for tagged PDFs. Default: TAGGED
  --untagged <name>   Output folder name for untagged PDFs. Default: UNTAGGED
  --json <file>       Write a JSON report.
  --help              Show this help.

Examples:
  node batch-classify-pdfs.js ./input
  node batch-classify-pdfs.js "C:\\PDFs" --copy --json report.json
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const inputFolder = args.shift();

  if (!inputFolder || inputFolder === "--help" || inputFolder === "-h") {
    return { help: true };
  }

  const options = { ...DEFAULT_OPTIONS, inputFolder, jsonReportPath: null };

  while (args.length > 0) {
    const arg = args.shift();

    if (arg === "--copy") {
      options.move = false;
    } else if (arg === "--recursive") {
      options.recursive = true;
    } else if (arg === "--tagged") {
      options.taggedFolderName = readOptionValue(args, arg);
    } else if (arg === "--untagged") {
      options.untaggedFolderName = readOptionValue(args, arg);
    } else if (arg === "--json") {
      options.jsonReportPath = readOptionValue(args, arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readOptionValue(args, optionName) {
  const value = args.shift();
  if (!value) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

async function loadPdfJs() {
  try {
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (error) {
    throw new Error(
      "Unable to load pdfjs-dist. Run `npm install` in this folder first.\n" +
        `Original error: ${error.message}`,
    );
  }
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function listPdfFiles(directory, recursive, excludedDirectories = new Set()) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (recursive && !excludedDirectories.has(path.resolve(fullPath))) {
        files.push(...listPdfFiles(fullPath, recursive, excludedDirectories));
      }
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizeRole(role) {
  if (!role) return null;
  if (typeof role === "string") return role;
  if (typeof role === "object" && typeof role.name === "string") return role.name;
  return String(role);
}

function scanStructTree(node, stats) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const child of node) scanStructTree(child, stats);
    return;
  }

  if (typeof node !== "object") return;

  const role = normalizeRole(node.role || node.name || node.type || node.S);
  if (role) {
    stats.roles.add(role);
    if (VALID_TAGS.has(role)) {
      stats.validTagCount += 1;
    }
  }

  if (node.type === "content" && typeof node.id === "string") {
    stats.mcidContentCount += 1;
    stats.contentIds.push(node.id);
  }

  if (Array.isArray(node.children)) {
    scanStructTree(node.children, stats);
  }
}

async function classifyPdf(pdfjsLib, pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
  });

  let pdf;

  try {
    pdf = await loadingTask.promise;
    const stats = {
      pageCount: pdf.numPages,
      pagesWithStructTree: 0,
      validTagCount: 0,
      mcidContentCount: 0,
      roles: new Set(),
      contentIds: [],
    };

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const structTree = await page.getStructTree();

      if (!structTree) {
        continue;
      }

      stats.pagesWithStructTree += 1;
      scanStructTree(structTree, stats);
      page.cleanup();
    }

    const isTagged =
      stats.pagesWithStructTree > 0 &&
      stats.validTagCount > 0 &&
      stats.mcidContentCount > 0;

    return {
      pdfPath,
      status: isTagged ? "TAGGED" : "UNTAGGED",
      reason: getReason(stats),
      pageCount: stats.pageCount,
      pagesWithStructTree: stats.pagesWithStructTree,
      validTagCount: stats.validTagCount,
      mcidContentCount: stats.mcidContentCount,
      roles: [...stats.roles].sort(),
    };
  } finally {
    if (pdf) {
      await pdf.destroy();
    } else {
      loadingTask.destroy();
    }
  }
}

function getReason(stats) {
  if (stats.pagesWithStructTree === 0) {
    return "No page structure tree was exposed.";
  }
  if (stats.validTagCount === 0) {
    return "Structure tree exists, but no valid target tags were found.";
  }
  if (stats.mcidContentCount === 0) {
    return "Valid tags exist, but no MCID-linked content items were found.";
  }
  return "Valid structure tags and MCID-linked content were found.";
}

function uniqueTargetPath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;

  const directory = path.dirname(targetPath);
  const extension = path.extname(targetPath);
  const baseName = path.basename(targetPath, extension);
  let index = 1;

  while (true) {
    const candidate = path.join(directory, `${baseName} (${index})${extension}`);
    if (!fs.existsSync(candidate)) return candidate;
    index += 1;
  }
}

function transferFile(sourcePath, targetDirectory, move) {
  ensureDirectory(targetDirectory);
  const targetPath = uniqueTargetPath(path.join(targetDirectory, path.basename(sourcePath)));

  if (move) {
    fs.renameSync(sourcePath, targetPath);
  } else {
    fs.copyFileSync(sourcePath, targetPath);
  }

  return targetPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  const inputFolder = path.resolve(options.inputFolder);
  if (!fs.existsSync(inputFolder) || !fs.statSync(inputFolder).isDirectory()) {
    throw new Error(`Input folder does not exist or is not a directory: ${inputFolder}`);
  }

  const taggedFolder = path.join(inputFolder, options.taggedFolderName);
  const untaggedFolder = path.join(inputFolder, options.untaggedFolderName);
  ensureDirectory(taggedFolder);
  ensureDirectory(untaggedFolder);

  const pdfjsLib = await loadPdfJs();
  const excludedDirectories = new Set([path.resolve(taggedFolder), path.resolve(untaggedFolder)]);
  const files = listPdfFiles(inputFolder, options.recursive, excludedDirectories);
  const results = [];

  for (const file of files) {
    const relativePath = path.relative(inputFolder, file);
    process.stdout.write(`Processing ${relativePath} ... `);

    try {
      const result = await classifyPdf(pdfjsLib, file);
      const targetDirectory = result.status === "TAGGED" ? taggedFolder : untaggedFolder;
      const targetPath = transferFile(file, targetDirectory, options.move);

      result.outputPath = targetPath;
      results.push(result);
      console.log(`${result.status} (${result.mcidContentCount} MCID items, ${result.validTagCount} valid tags)`);
    } catch (error) {
      const result = {
        pdfPath: file,
        status: "UNTAGGED",
        reason: `Unable to parse PDF: ${error.message}`,
        outputPath: transferFile(file, untaggedFolder, options.move),
        error: error.message,
      };

      results.push(result);
      console.log(`UNTAGGED (parse error: ${error.message})`);
    }
  }

  if (options.jsonReportPath) {
    const reportPath = path.resolve(options.jsonReportPath);
    ensureDirectory(path.dirname(reportPath));
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  }

  const taggedCount = results.filter((result) => result.status === "TAGGED").length;
  const untaggedCount = results.length - taggedCount;

  console.log(`Done. ${taggedCount} tagged, ${untaggedCount} untagged.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
