const hre = require("hardhat");

async function main() {
  const POSM = process.env.POSM;                 
  const LOCK_FEE_ETH = process.env.LOCK_FEE_ETH; 
  const FEE_COLLECTOR = process.env.FEE_COLLECTOR; 

  if (!POSM) throw new Error("Set POSM in .env to your NonfungiblePositionManager address");

  const lockFeeWei = LOCK_FEE_ETH
    ? hre.ethers.parseEther(LOCK_FEE_ETH)
    : 0n;

  const feeCollector =
    FEE_COLLECTOR && FEE_COLLECTOR !== ""
      ? FEE_COLLECTOR
      : "0x0000000000000000000000000000000000000000";

  const Locker = await hre.ethers.getContractFactory("EPOWLocker");
  const locker = await Locker.deploy(POSM, lockFeeWei, feeCollector);
  await locker.waitForDeployment();

  console.log("Locker:", await locker.getAddress());
  console.log("POSM:", POSM);
  console.log("lockFee (wei):", lockFeeWei.toString());
  console.log("feeCollector:", feeCollector);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
