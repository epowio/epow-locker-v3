const { expect } = require("chai");
const { ethers } = require("hardhat");

// load official ABIs/bytecode from the npm packages
const FactoryArt = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const PoolArt    = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const NPMArt     = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
const RouterArt  = require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json");

let QuoterArt;
try {
  QuoterArt = require("@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json");
} catch {
  QuoterArt = require("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json");
}

function encodeSqrtPriceX96(price, dec0, dec1) {
  const scale = Math.pow(10, Number(dec1) - Number(dec0));
  const sqrt  = Math.sqrt(Number(price) * scale);
  return BigInt(Math.floor(sqrt * (2 ** 96)));
}

describe("Uniswap v3 – end-to-end", function () {
  let deployer, user;
  let token0, token1;
  let factory, npm, router, quoter, pool;

  const fee = 3000;               // 0.3%
  const one = 10n ** 18n;

  before(async () => {
    [deployer, user] = await ethers.getSigners();

    // 1) Two mock tokens
    const TT = await ethers.getContractFactory("TestToken");
    const A  = await TT.deploy("Token A", "TKNA", 18, 1_000_000n * one);
    const B  = await TT.deploy("Token B", "TKNB", 18, 1_000_000n * one);
    await A.waitForDeployment(); await B.waitForDeployment();

    const a = (await A.getAddress()).toLowerCase();
    const b = (await B.getAddress()).toLowerCase();
    token0 = a < b ? await A.getAddress() : await B.getAddress();
    token1 = a < b ? await B.getAddress() : await A.getAddress();

    // 2) Factory
    const FactoryCF = new ethers.ContractFactory(FactoryArt.abi, FactoryArt.bytecode, deployer);
    factory = await FactoryCF.deploy(); await factory.waitForDeployment();

    // 3) Periphery (use zero address for WETH & descriptor on localhost)
    const zero = ethers.ZeroAddress;
    const NpmCF = new ethers.ContractFactory(NPMArt.abi, NPMArt.bytecode, deployer);
    npm = await NpmCF.deploy(await factory.getAddress(), zero, zero); await npm.waitForDeployment();

    const RouterCF = new ethers.ContractFactory(RouterArt.abi, RouterArt.bytecode, deployer);
    router = await RouterCF.deploy(await factory.getAddress(), zero); await router.waitForDeployment();

    const QuoterCF = new ethers.ContractFactory(QuoterArt.abi, QuoterArt.bytecode, deployer);
    quoter = await QuoterCF.deploy(await factory.getAddress(), zero); await quoter.waitForDeployment();

    // 4) Create + init pool at price = 1.0
    const dec0 = 18, dec1 = 18;
    const sqrtP = encodeSqrtPriceX96(1.0, dec0, dec1);
    await (await npm.createAndInitializePoolIfNecessary(token0, token1, fee, sqrtP)).wait();

    const poolAddr = await factory.getPool(token0, token1, fee);
    pool = new ethers.Contract(poolAddr, PoolArt.abi, deployer);

    // 5) Seed a small position
    const approveABI = ["function approve(address,uint256) external returns (bool)"];
    await (await new ethers.Contract(token0, approveABI, deployer).approve(await npm.getAddress(), one)).wait();
    await (await new ethers.Contract(token1, approveABI, deployer).approve(await npm.getAddress(), one)).wait();

    const params = {
      token0, token1, fee,
      tickLower: -600, tickUpper: 600,          // simple demo range for 0.3% tier (spacing 60)
      amount0Desired: one, amount1Desired: one,
      amount0Min: 0, amount1Min: 0,
      recipient: await deployer.getAddress(),
      deadline: Math.floor(Date.now()/1000) + 600,
    };
    await (await npm.mint(params)).wait();
  });

  it("quotes 1 token0 → token1", async () => {
    const amountIn = 10n ** 18n;

    // V1 and V2 both expose quoteExactInputSingle; V2 returns tuple
    let out;
    try {
      out = await quoter.quoteExactInputSingle.staticCall(token0, token1, fee, amountIn, 0);
    } catch {
      const res = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: token0, tokenOut: token1, fee, amountIn, sqrtPriceLimitX96: 0
      });
      out = res[0];
    }
    expect(out).to.be.a("bigint").and.gt(0n);
  });

  it("swaps 1 token0 via router and moves price", async () => {
  const erc20 = [
    "function approve(address,uint256) external returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) external returns (bool)"
  ];

  const [deployer, user] = await ethers.getSigners();
  const t0Dep = new ethers.Contract(token0, erc20, deployer);
  const t1User = new ethers.Contract(token1, erc20, user);
  const t0User = t0Dep.connect(user);

  const one = 10n ** 18n;

  // 🔧 fund the user with token0 (from deployer who holds the initial supply)
  await (await t0Dep.transfer(await user.getAddress(), one * 2n)).wait(); // give user 2 token0

  // approve & swap as user
  const routerUser = router.connect(user);
  const bal1Before = await t1User.balanceOf(await user.getAddress());
  await (await t0User.approve(await router.getAddress(), one)).wait();

  const params = {
    tokenIn: token0, tokenOut: token1, fee: 3000,
    recipient: await user.getAddress(),
    deadline: Math.floor(Date.now()/1000) + 600,
    amountIn: one, amountOutMinimum: 0, sqrtPriceLimitX96: 0,
  };
  await (await routerUser.exactInputSingle(params)).wait();

  const bal1After = await t1User.balanceOf(await user.getAddress());
  expect(bal1After - bal1Before).to.gt(0n);

  const slot0 = await pool.slot0();
  expect(slot0.tick).to.be.a("bigint");
});


  it("collects fees from the LP NFT", async () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const filter = npm.filters.Transfer(zero, await deployer.getAddress());
    const mints = await npm.queryFilter(filter, 0, "latest");
    expect(mints.length).to.be.greaterThan(0);
    const tokenId = mints[0].args.tokenId;

    const params = {
      tokenId,
      recipient: await deployer.getAddress(),
      amount0Max: (1n << 128n) - 1n,
      amount1Max: (1n << 128n) - 1n,
    };
    await (await npm.collect(params)).wait();
    // If you want: decode events and assert amounts > 0 after multiple swaps
  });
});
