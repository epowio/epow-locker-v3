const fs = require("fs");
const path = require("path");

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

function main() {
  const found = findBuildInfoFor(TARGET_SRC, TARGET_NAME);
  if (!found) {
    console.error(`❌ Could not find ${TARGET_SRC}:${TARGET_NAME} in artifacts/build-info`);
    process.exit(1);
  }

  const { buildInfoPath, bi, hit } = found;
  const solcVersion = bi.solcVersion || bi.solcLongVersion || "unknown";

  // 1) Pure Standard JSON Input for OKLink
  const stdInput = {
    language: bi.input?.language || "Solidity",
    sources: bi.input?.sources || {},
    settings: bi.input?.settings || {},
  };

  // 2) Optional helper metadata for you (NOT for OKLink form)
  const meta = {
    contractFile: TARGET_SRC,
    contractName: TARGET_NAME,
    abi: hit.abi,
    bytecode: hit.evm.bytecode.object,
    deployedBytecode: hit.evm.deployedBytecode.object,
    compiler: solcVersion,
  };

  fs.mkdirSync("flattened", { recursive: true });

  const stdPath = path.join("flattened", `${TARGET_NAME}.stdinput.json`);
  const metaPath = path.join("flattened", `${TARGET_NAME}.meta.json`);

  fs.writeFileSync(stdPath, JSON.stringify(stdInput, null, 2));
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log(`✅ Wrote Standard JSON Input: ${stdPath}`);
  console.log(`✅ Wrote meta helper:        ${metaPath}`);
  console.log(`🔧 Compiler: ${solcVersion}`);
  console.log(`📄 Build info: ${buildInfoPath}`);
}

main();
