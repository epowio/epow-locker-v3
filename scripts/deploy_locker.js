const hre = require("hardhat");

async function main() {
  const POSM = process.env.POSM;
  if (!POSM) throw new Error("Set POSM in .env to your NonfungiblePositionManager address");

  const Locker = await hre.ethers.getContractFactory("EPOWLocker");
  const locker = await Locker.deploy(POSM);
  await locker.waitForDeployment();

  console.log("Locker:", await locker.getAddress());
}
main().catch((e) => { console.error(e); process.exit(1); });
