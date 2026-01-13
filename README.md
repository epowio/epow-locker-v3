# EPoW Token Creator

Production-ready ERC20 token + factory for EthereumPoW (ETHW) and other EVM chains.

This repo contains:

- `TokenCreator.sol`: ERC20 + burnable + admin controls (mint, freeze, revoke, finalize, metadata).
- `TokenCreatorFactory.sol`: Factory that mints new `TokenCreator` instances with a fixed creation fee.
- Hardhat config, test suite, deploy script, and standard JSON exporter for contract verification.

---

## Live Deployment (EthereumPoW)

- **Network:** EthereumPoW (ETHW)
- **Token Creator Address:** `0x934389f8B37E40098505cF381f882Fb9D83C3491`
- **Verified source (OKLink):**  
https://www.oklink.com/ethereum-pow/address/0x745356c815f9121c4d5866231ed3f343fdd0c99d/contract


## Contracts

### TokenCreator.sol

ERC20 with:

- `ERC20`, `ERC20Burnable`, `Ownable`, `ReentrancyGuard`
- Owner-only mint with safety flags:
  - `mintingFrozen` — temporary mint freeze
  - `mintAuthorityRevoked` — permanent mint disable
- Hard controls:
  - `freezeMinting()` / `unfreezeMinting()`
  - `revokeMintAuthority()` — permanent; cannot be undone
  - `finalizeToken()` — permanently disables minting and renounces ownership
- Metadata:
  - `tokenImageURL` (string)
  - `tokenDescription` (string)
  - `setTokenImageURL(...)`, `setTokenDescription(...)`
  - `getTokenMetadata()` returns `(imageURL, description)`
- Burning:
  - `burn(amount)` — holder burns own tokens
  - `burnFrom(account, amount)` — burns with allowance

Key constructor:

```solidity
constructor(
    string memory name,
    string memory symbol,
    uint256 initialSupply,
    string memory imageURL,
    string memory description,
    address creator
) ERC20(name, symbol) Ownable() {
    _transferOwnership(creator);
    _mint(creator, initialSupply * 10 ** decimals());
    ...
}




