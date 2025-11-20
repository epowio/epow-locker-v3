// Load ABIs/bytecode straight from the official packages
exports.core = {
  Factory: require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"),
  Pool:    require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json"),
};
exports.periphery = {
  NPM:    require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
  Router: require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json"),
  Quoter: (() => {
    try {
      return require("@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json");
    } catch {
      return require("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json");
    }
  })(),
  TickLens: require("@uniswap/v3-periphery/artifacts/contracts/lens/TickLens.sol/TickLens.json"),
};
