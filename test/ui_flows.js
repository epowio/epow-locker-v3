const { expect } = require("chai");
const { ethers } = require("hardhat");

const FactoryArt = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const PoolArt    = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const NPMArt     = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
const RouterArt  = require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json");
let   QuoterArt;
try { QuoterArt = require("@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json"); }
catch { QuoterArt = require("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json"); }

const FEE = 3000;                         // 0.3% tier
const TICK_SPACING = 60;                  // for 0.3%
const ONE = 10n ** 18n;

// helpers
const erc20 = [
  "function approve(address,uint256) external returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address,uint256) external returns (bool)"
];

function encodeSqrtPriceX96(price, dec0, dec1) {
  const scale = Math.pow(10, Number(dec1) - Number(dec0));
  const sqrt  = Math.sqrt(Number(price) * scale);
  return BigInt(Math.floor(sqrt * (2 ** 96)));
}
function nearestUsableTick(tick, spacing) { return Math.floor(tick/spacing)*spacing; }
function priceToTick(p) { return Math.floor(Math.log(Number(p))/Math.log(1.0001)); }

describe("UI flows a frontend will implement", function () {
  let deployer, user, factory, router, quoter, npm, pool, token0, token1, dec0, dec1, tokenId;

  before(async () => {
    [deployer, user] = await ethers.getSigners();

    // 1) Deploy two mock 18-dec tokens (A/B)
    const TT = await ethers.getContractFactory("TestToken");
    const A  = await TT.deploy("Token A", "TKNA", 18, 1_000_000n * ONE);
    const B  = await TT.deploy("Token B", "TKNB", 18, 1_000_000n * ONE);
    await A.waitForDeployment(); await B.waitForDeployment();

    const a = (await A.getAddress()).toLowerCase();
    const b = (await B.getAddress()).toLowerCase();
    token0 = new ethers.Contract(a < b ? await A.getAddress() : await B.getAddress(), erc20, deployer);
    token1 = new ethers.Contract(a < b ? await B.getAddress() : await A.getAddress(), erc20, deployer);
    dec0 = Number(await token0.decimals());
    dec1 = Number(await token1.decimals());

    // 2) Core + periphery
    const FCF = new ethers.ContractFactory(FactoryArt.abi, FactoryArt.bytecode, deployer);
    factory = await FCF.deploy(); await factory.waitForDeployment();

    const zero = ethers.ZeroAddress;
    const NCF = new ethers.ContractFactory(NPMArt.abi, NPMArt.bytecode, deployer);
    npm = await NCF.deploy(await factory.getAddress(), zero, zero); await npm.waitForDeployment();

    const RCF = new ethers.ContractFactory(RouterArt.abi, RouterArt.bytecode, deployer);
    router = await RCF.deploy(await factory.getAddress(), zero); await router.waitForDeployment();

    const QCF = new ethers.ContractFactory(QuoterArt.abi, QuoterArt.bytecode, deployer);
    quoter = await QCF.deploy(await factory.getAddress(), zero); await quoter.waitForDeployment();

    // 3) Create + initialize pool at price=1.0
    const sqrtP = encodeSqrtPriceX96(1.0, dec0, dec1);
    await (await npm.createAndInitializePoolIfNecessary(await token0.getAddress(), await token1.getAddress(), FEE, sqrtP)).wait();
    const poolAddr = await factory.getPool(await token0.getAddress(), await token1.getAddress(), FEE);
    pool = new ethers.Contract(poolAddr, PoolArt.abi, deployer);

    // 4) Seed narrow position for demo ([-600, +600])
    await (await token0.approve(await npm.getAddress(), ONE)).wait();
    await (await token1.approve(await npm.getAddress(), ONE)).wait();
    const params = {
      token0: await token0.getAddress(), token1: await token1.getAddress(), fee: FEE,
      tickLower: -600, tickUpper: 600,
      amount0Desired: ONE, amount1Desired: ONE,
      amount0Min: 0, amount1Min: 0,
      recipient: await deployer.getAddress(),
      deadline: Math.floor(Date.now()/1000) + 600,
    };
    const mintTx = await npm.mint(params); const rc = await mintTx.wait();
    // infer tokenId from Transfer(0x0 -> deployer)
    const zeroAddr = "0x0000000000000000000000000000000000000000";
    const mints = await npm.queryFilter(npm.filters.Transfer(zeroAddr, await deployer.getAddress()), rc.blockNumber, rc.blockNumber);
    tokenId = mints[0].args.tokenId;
  });

  it("UI: show pool header (price/tick/liquidity)", async () => {
    const [sqrtPriceX96, tick] = await pool.slot0();
    const liq = await pool.liquidity();

    // UI display values
    const price = (Number(sqrtPriceX96) / (2 ** 96)) ** 2 * Math.pow(10, dec0 - dec1); // token1/token0
    console.log("UI header → price", price.toFixed(6), "tick", Number(tick), "liquidity", liq.toString());
    expect(price).to.be.greaterThan(0);
  });

  it("UI: approval flow (check allowance → approve if needed)", async () => {
    const userT0 = token0.connect(user);
    const allowance = await userT0.allowance(await user.getAddress(), await router.getAddress());
    if (allowance < ONE) {
      // In a real UI you'd show an "Approve" button first
      // give user some token0 then approve
      await (await token0.transfer(await user.getAddress(), ONE * 3n)).wait();
      await (await userT0.approve(await router.getAddress(), ONE * 10n)).wait();
    }
    const post = await userT0.allowance(await user.getAddress(), await router.getAddress());
    expect(post >= ONE).to.equal(true);
  });

  it("UI: quote exactOut + cap max input + swap exactOutputSingle", async () => {
  const tokenIn  = await token0.getAddress();
  const tokenOut = await token1.getAddress();

  // Helper: exact-in quote (works with Quoter V1 or V2)
  const quoteExactIn = async (ain) => {
    try {
      // V1 positional
      return await quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, FEE, ain, 0);
    } catch {
      // V2 struct
      const r = await quoter.quoteExactInputSingle.staticCall({
        tokenIn, tokenOut, fee: FEE, amountIn: ain, sqrtPriceLimitX96: 0
      });
      return r[0];
    }
  };

  // 1) Learn a feasible target from a small exact-in quote
  const probeIn = 5n * (10n ** 17n); // 0.5 token0
  const probeOut = await quoteExactIn(probeIn);
  // If still zero, give the pool a tiny nudge or widen liquidity in earlier tests.
  if (probeOut === 0n) throw new Error("Pool too shallow for exact-out demo (probeOut=0)");

  // Choose a target you KNOW is reachable: half of probeOut
  const amountOutDesired = probeOut / 2n;
  expect(amountOutDesired).to.be.gt(0n);

  // 2) Find minimal input that reaches amountOutDesired (doubling + binary search)
  let lo = 0n, hi = probeIn; // start from our probe input
  // Ensure hi is enough; double until out >= desired (with a cap)
  for (let i = 0; i < 32; i++) {
    const out = await quoteExactIn(hi);
    if (out >= amountOutDesired) break;
    hi *= 2n;
    if (i === 31) throw new Error("unreachable target with current liquidity");
  }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) >> 1n;
    const out = await quoteExactIn(mid);
    if (out >= amountOutDesired) hi = mid; else lo = mid;
  }
  const amountInQuoted = hi;

  // 3) UI slippage buffer (+1%)
  const maxIn = amountInQuoted * 101n / 100n;

  // 4) Ensure user has balance & allowance
  const [, userSigner] = await ethers.getSigners();
  const t0User = token0.connect(userSigner);
  const need = maxIn + (10n ** 18n); // headroom for approvals
  const bal0 = await t0User.balanceOf(await userSigner.getAddress());
  if (bal0 < need) await (await token0.transfer(await userSigner.getAddress(), need - bal0)).wait();
  const allowance = await t0User.allowance(await userSigner.getAddress(), await router.getAddress());
  if (allowance < maxIn) await (await t0User.approve(await router.getAddress(), maxIn)).wait();

  // 5) Swap exact output with cap on max input
  const routerU = router.connect(userSigner);
  await (await routerU.exactOutputSingle({
    tokenIn, tokenOut, fee: FEE,
    recipient: await userSigner.getAddress(),
    deadline: Math.floor(Date.now()/1000) + 600,
    amountOut: amountOutDesired,
    amountInMaximum: maxIn,
    sqrtPriceLimitX96: 0
  })).wait();
});


 it("UI: quote exactOut + cap max input + swap exactOutputSingle", async () => {
  const tokenIn  = await token0.getAddress();
  const tokenOut = await token1.getAddress();

  const amountOutDesired = 2n * (10n ** 17n); // 0.2 token1

  // Helper that quotes exact-in for either Quoter V1 or V2
  const quoteExactIn = async (ain) => {
    try {
      // V1 positional
      return await quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, FEE, ain, 0);
    } catch {
      // V2 struct
      const r = await quoter.quoteExactInputSingle.staticCall({
        tokenIn, tokenOut, fee: FEE, amountIn: ain, sqrtPriceLimitX96: 0
      });
      return r[0];
    }
  };

  // 1) Find upper bound for input (double until output >= desired)
  let lo = 0n, hi = 10n ** 16n; // start at 0.01
  while ((await quoteExactIn(hi)) < amountOutDesired) {
    hi *= 2n;
    if (hi > 10n ** 30n) throw new Error("search overflow");
  }

  // 2) Binary search for minimal input that achieves desired out
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) >> 1n;
    const out = await quoteExactIn(mid);
    if (out >= amountOutDesired) hi = mid; else lo = mid;
  }
  const amountInQuoted = hi;

  // UI slippage: +1% buffer
  const maxIn = amountInQuoted * 101n / 100n;

  // Ensure user has balance & allowance
  const [, userSigner] = await ethers.getSigners();
  const t0User = token0.connect(userSigner);
  const bal0 = await t0User.balanceOf(await userSigner.getAddress());
  if (bal0 < maxIn) await (await token0.transfer(await userSigner.getAddress(), (maxIn - bal0) + (10n**18n))).wait();
  const allowance = await t0User.allowance(await userSigner.getAddress(), await router.getAddress());
  if (allowance < maxIn) await (await t0User.approve(await router.getAddress(), maxIn)).wait();

  // Swap exact output with cap on max input
  const routerU = router.connect(userSigner);
  await (await routerU.exactOutputSingle({
    tokenIn, tokenOut, fee: FEE,
    recipient: await userSigner.getAddress(),
    deadline: Math.floor(Date.now()/1000) + 600,
    amountOut: amountOutDesired,
    amountInMaximum: maxIn,
    sqrtPriceLimitX96: 0
  })).wait();
});



  it("UI: list my LP NFTs & show ranges/liquidity/fees", async () => {
    // In a UI you'd call a subgraph; here we read NPM directly
    const zero = "0x0000000000000000000000000000000000000000";
    const mintEvents = await npm.queryFilter(npm.filters.Transfer(zero, await deployer.getAddress()), 0, "latest");
    expect(mintEvents.length).to.be.greaterThan(0);
    const id = mintEvents[0].args.tokenId;
    const pos = await npm.positions(id);
    // pos: { nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, feeGrowth… tokensOwed0/1 }
    console.log("UI Positions → id", id.toString(), "ticks", Number(pos.tickLower), Number(pos.tickUpper), "liquidity", pos.liquidity.toString());
    expect(pos.liquidity).to.be.a("bigint");
  });

  it("UI: increase liquidity by range (center ±10%)", async () => {
    // compute ticks from current price (±10%)
    const [sqrtPriceX96,] = await pool.slot0();
    const priceNow = (Number(sqrtPriceX96) / (2 ** 96)) ** 2 * Math.pow(10, dec0 - dec1);
    const pLow  = priceNow * 0.90, pHigh = priceNow * 1.10;
    let tickLower = nearestUsableTick(priceToTick(pLow), TICK_SPACING);
    let tickUpper = nearestUsableTick(priceToTick(pHigh), TICK_SPACING);
    if (tickLower === tickUpper) tickUpper = tickLower + TICK_SPACING;

    // approve extra tokens to NPM
    await (await token0.approve(await npm.getAddress(), ONE * 5n)).wait();
    await (await token1.approve(await npm.getAddress(), ONE * 5n)).wait();

    const params = {
      tokenId,
      amount0Desired: ONE * 2n,
      amount1Desired: ONE * 2n,
      amount0Min: 0,
      amount1Min: 0,
      deadline: Math.floor(Date.now()/1000) + 600,
      // NOTE: increaseLiquidity ignores ticks (range set at mint). To mint a *new* range, call `mint` again.
    };
    const tx = await npm.increaseLiquidity(params);
    await tx.wait();
  });

  it("UI: decrease liquidity 50% and collect", async () => {
    // read position first
    const before = await npm.positions(tokenId);
    const half = before.liquidity / 2n;

    const tx1 = await npm.decreaseLiquidity({
      tokenId,
      liquidity: half,
      amount0Min: 0,
      amount1Min: 0,
      deadline: Math.floor(Date.now()/1000) + 600
    });
    await tx1.wait();

    const tx2 = await npm.collect({
      tokenId,
      recipient: await deployer.getAddress(),
      amount0Max: (1n<<128n)-1n,
      amount1Max: (1n<<128n)-1n
    });
    await tx2.wait();

    const after = await npm.positions(tokenId);
    expect(after.liquidity).to.equal(before.liquidity - half);
  });

  it("UI: error state – expired deadline", async () => {
    const routerU = router.connect(user);
    await expect(routerU.exactInputSingle({
      tokenIn: await token0.getAddress(), tokenOut: await token1.getAddress(), fee: FEE,
      recipient: await user.getAddress(),
      deadline: Math.floor(Date.now()/1000) - 1, // already expired
      amountIn: ONE, amountOutMinimum: 0, sqrtPriceLimitX96: 0
    })).to.be.reverted; // UI should show “Transaction deadline expired”
  });

  it("UI: error state – slippage (amountOutMinimum too high)", async () => {
    const routerU = router.connect(user);
    // demand impossible minOut
    await expect(routerU.exactInputSingle({
      tokenIn: await token0.getAddress(), tokenOut: await token1.getAddress(), fee: FEE,
      recipient: await user.getAddress(),
      deadline: Math.floor(Date.now()/1000) + 600,
      amountIn: ONE, amountOutMinimum: ONE, sqrtPriceLimitX96: 0
    })).to.be.reverted; // UI should show “INSUFFICIENT_OUTPUT_AMOUNT” style message
  });
});
