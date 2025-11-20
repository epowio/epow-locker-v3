# EPOWLocker

`EPOWLocker`  non-custodial Uniswap V3 LP position locker.

It escrows Uniswap V3 LP position NFTs (from `INonfungiblePositionManager`) until a specified unlock timestamp. There is no owner backdoor; only the designated beneficiary can withdraw after unlock. While locked, any accrued fees can optionally be collected to a configurable `feesRecipient`.

This contract is designed for:

- Locking Uniswap V3 LP NFTs to signal trust and prevent early rug-pulls
- Allowing the original depositor to configure unlock time and fee routing
- Enforcing a strict ERC721 receiver gate to reject unsolicited NFTs


## Live Deployment (EthereumPoW)

- **Network:** EthereumPoW (ETHW)
- **Locker Address:** `0x4fD54E9686e5944697926d1fF231DCfA9f8D4E05`
- **Verified source (OKLink):**  
 https://www.oklink.com/ethereum-pow/address/0x4fd54e9686e5944697926d1ff231dcfa9f8d4e05/contract


## Features

- Locks Uniswap V3 LP position NFTs (ERC-721) until a specific `unlockTime`
- Supports:
  - `lock` via standard `approve()` + `safeTransferFrom`
  - `lockWithPermit` via `INonfungiblePositionManager.permit()` (gasless approval)
- No privileged owner functions; no backdoor withdrawals
- Separate roles:
  - `depositor`: original locker, can extend lock and adjust fee recipient
  - `beneficiary`: can withdraw NFT after `unlockTime`
- Optional fee collection:
  - Collected fees are sent to `feesRecipient` (default = `beneficiary`)
- Reentrancy guard on state-changing external calls
- Strict ERC721 receiver gate:
  - Only accepts NFTs from the configured `INonfungiblePositionManager`
  - Only accepts NFTs that were explicitly expected by an internal `lock` or `lockWithPermit` call


<!-- npx hardhat flatten contracts/EPOWLocker.sol > flattened/EPOWLocker.flattened.sol -->

## Contract Overview

### Interfaces

- `INonfungiblePositionManager`
  - Minimal subset of the Uniswap V3 Position Manager interface:
    - `ownerOf`, `safeTransferFrom`, `getApproved`, `approve`
    - `permit` for gasless approval
    - `collect` for fee collection

- `IERC721Receiver`
  - Standard ERC-721 receiver interface to support `safeTransferFrom`


### Storage

```solidity
struct Lock {
    address depositor;
    address beneficiary;
    address feesRecipient;
    uint64  unlockTime;
    bool    active;
}

INonfungiblePositionManager public immutable posm;
mapping(uint256 => Lock) public locks;      // tokenId => Lock
mapping(uint256 => bool)  private _expecting; // tokenId => inbound transfer gate
uint256 private _status;                    // reentrancy guard
