// scripts/gen-verify-files.js
// Node script to generate:
// 1) Standard JSON input for verification
// 2) Meta helper JSON
// 3) Flattened Solidity source (cleaned SPDX + pragma)
//
// Usage:
//   node scripts/gen-verify-files.js
//
// Requires:
//   - Hardhat in the project (npx hardhat available)
//   - Contract compiled (artifacts/build-info exists)

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const TARGET_SRC = "contracts/EPOWLocker.sol";
const TARGET_NAME = "EPOWLocker";

function findBuildInfoFor(contractSrc, contractName) {
  const dir = path.join(process.cwd(), "artifacts", "build-info");
  const files = fs.readdirSync(dir);

  for (const f of files) {
    const full = path.join(dir, f);
    const bi = require(full);

    const out = bi?.output?.contracts ?? {};
    const hit = out[contractSrc]?.[contractName];
    if (hit && hit.evm?.bytecode?.object && Array.isArray(hit.abi)) {
      return { buildInfoPath: full, bi, hit };
    }
  }
  return null;
}

// Clean flattened solidity: keep only first SPDX + first pragma
function cleanFlattenedSource(src) {
  const lines = src.split(/\r?\n/);
  let seenSpdx = false;
  let seenPragma = false;

  const cleaned = [];

  for (let line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("// SPDX-License-Identifier:")) {
      if (seenSpdx) continue;
      seenSpdx = true;
      cleaned.push(line);
      continue;
    }

    if (trimmed.startsWith("pragma solidity")) {
      if (seenPragma) continue;
      seenPragma = true;
      cleaned.push(line);
      continue;
    }

    cleaned.push(line);
  }

  return cleaned.join("\n");
}

function main() {
  // 1) Find build-info entry for EPOWLocker
  const found = findBuildInfoFor(TARGET_SRC, TARGET_NAME);
  if (!found) {
    console.error(`❌ Could not find ${TARGET_SRC}:${TARGET_NAME} in artifacts/build-info`);
    process.exit(1);
  }

  const { buildInfoPath, bi, hit } = found;
  const solcVersion = bi.solcVersion || bi.solcLongVersion || "unknown";

  // 2) Standard JSON input (for OKLink "Standard JSON" verification)
  const stdInput = {
    language: bi.input?.language || "Solidity",
    sources: bi.input?.sources || {},
    settings: bi.input?.settings || {},
  };

  // 3) Meta helper (for you, not for explorer)
  const meta = {
    contractFile: TARGET_SRC,
    contractName: TARGET_NAME,
    abi: hit.abi,
    bytecode: hit.evm.bytecode.object,
    deployedBytecode: hit.evm.deployedBytecode.object,
    compiler: solcVersion,
  };

  // 4) Generate flattened solidity via Hardhat
  //    Equivalent to: npx hardhat flatten contracts/EPOWLocker.sol
  let flattenedRaw;
  try {
    flattenedRaw = execSync(`npx hardhat flatten ${TARGET_SRC}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (err) {
    console.error("❌ Failed to run `npx hardhat flatten`");
    console.error(err.message || err);
    process.exit(1);
  }

  const flattenedClean = cleanFlattenedSource(flattenedRaw);

  // 5) Write outputs
  fs.mkdirSync("flattened", { recursive: true });

  const stdPath = path.join("flattened", `${TARGET_NAME}.stdinput.json`);
  const metaPath = path.join("flattened", `${TARGET_NAME}.meta.json`);
  const flatPath = path.join("flattened", `${TARGET_NAME}.flatten.sol`);

  fs.writeFileSync(stdPath, JSON.stringify(stdInput, null, 2));
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  fs.writeFileSync(flatPath, flattenedClean);

  console.log(`✅ Wrote Standard JSON Input: ${stdPath}`);
  console.log(`✅ Wrote meta helper:        ${metaPath}`);
  console.log(`✅ Wrote flattened Solidity: ${flatPath}`);
  console.log(`🔧 Compiler: ${solcVersion}`);
  console.log(`📄 Build info: ${buildInfoPath}`);
}

main();
