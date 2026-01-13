// Sources flattened with hardhat v2.26.3 https://hardhat.org

// SPDX-License-Identifier: MIT

// File contracts/EPOWLocker.sol

// Original license: SPDX_License_Identifier: MIT
pragma solidity ^0.8.19;

/**
 * EPOWLocker
 * - Escrows Uniswap V3 LP position NFTs (ERC-721 from NonfungiblePositionManager) until a timestamp.
 * - No owner backdoors. Only the designated beneficiary can withdraw after unlock.
 * - Optional fee collection while locked (to beneficiary or a custom feesRecipient).
 * - Global lock fee in native ETHW, forwarded to a configurable feeCollector.
 * - feeCollector can be set later by owner.
 * - Supports lock via prior approve() OR gasless lockWithPermit().
 * - Rejects unsolicited NFT transfers using a strict ERC721Receiver gate.
 */
interface INonfungiblePositionManager {
    // ERC-721
    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function getApproved(uint256 tokenId) external view returns (address);
    function approve(address to, uint256 tokenId) external;

    // Permit (gasless approval)
    function permit(
        address spender,
        uint256 tokenId,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external;

    // Fee collection
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    function collect(CollectParams calldata params)
        external
        returns (uint256 amount0, uint256 amount1);
}

interface IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

contract EPOWLocker is IERC721Receiver {
    // ------------------------------------------------------------
    // Reentrancy guard
    // ------------------------------------------------------------
    uint256 private _status;
    modifier nonReentrant() {
        require(_status != 2, "REENTRANCY");
        _status = 2;
        _;
        _status = 1;
    }

    // ------------------------------------------------------------
    // Ownership + protocol lock fee
    // ------------------------------------------------------------
    address public owner;
    uint256 public lockFee;          // fee per lock, in wei
    address public feeCollector;     // where the lock fee is forwarded

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    struct Lock {
        address depositor;        // original owner that initiated the lock
        address beneficiary;      // who can withdraw after unlock
        address feesRecipient;    // who receives collected fees during lock 
        uint64  unlockTime;       // unix seconds
        bool    active;           // true while held
    }

    // ---- State ----
    INonfungiblePositionManager public immutable posm;
    mapping(uint256 => Lock) public locks;          // tokenId => Lock
    mapping(uint256 => bool)  private _expecting;   // tokenId => expect inbound transfer gate

    // ---- Events ----
    event Locked(uint256 indexed tokenId, address indexed depositor, address indexed beneficiary, uint64 unlockTime);
    event Extended(uint256 indexed tokenId, uint64 oldUnlock, uint64 newUnlock);
    event FeesRecipientSet(uint256 indexed tokenId, address indexed oldRecipient, address indexed newRecipient);
    event FeesCollected(uint256 indexed tokenId, address indexed to, uint256 amount0, uint256 amount1);
    event Withdrawn(uint256 indexed tokenId, address to);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event LockFeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);

    // ---- Errors ----
    error NotOwner();
    error NotActive();
    error AlreadyActive();
    error NotApproved();
    error InvalidTime();
    error TooSoon();
    error NotPOSM();
    error UnexpectedToken();
    error IncorrectFee(uint256 sent, uint256 required);
    error FeeTransferFailed();
    error FeeCollectorUnset();

    constructor(address _posm, uint256 _lockFee, address _initialFeeCollector) {
        require(_posm != address(0), "POSM_ZERO");

        posm = INonfungiblePositionManager(_posm);
        _status = 1;

        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);

        lockFee = _lockFee;
        emit LockFeeUpdated(0, _lockFee);

        // feeCollector can be zero here; owner can set it later
        feeCollector = _initialFeeCollector;
        emit FeeCollectorUpdated(address(0), _initialFeeCollector);
    }

    // ------------------------------------------------------------
    // Owner functions (fee + ownership)
    // ------------------------------------------------------------
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_ADDR");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setLockFee(uint256 newFee) external onlyOwner {
        uint256 old = lockFee;
        lockFee = newFee;
        emit LockFeeUpdated(old, newFee);
    }

    function setFeeCollector(address newCollector) external onlyOwner {
        // allow setting from zero to non-zero anytime
        require(newCollector != address(0), "ZERO_ADDR");
        address old = feeCollector;
        feeCollector = newCollector;
        emit FeeCollectorUpdated(old, newCollector);
    }

    // ------------------------------------------------------------
    // Internal helper for fee forwarding
    // ------------------------------------------------------------
    function _takeAndForwardFee() internal {
        if (lockFee == 0) {
            if (msg.value != 0) {
                revert IncorrectFee(msg.value, lockFee);
            }
            return;
        }

        if (msg.value != lockFee) {
            revert IncorrectFee(msg.value, lockFee);
        }

        address collector = feeCollector;
        if (collector == address(0)) {
            revert FeeCollectorUnset();
        }

        (bool ok, ) = collector.call{value: msg.value}("");
        if (!ok) revert FeeTransferFailed();
    }

    // ------------------------------------------------------------
    // Core: lock via prior approve()
    // ------------------------------------------------------------
    function lock(
        uint256 tokenId,
        address beneficiary,
        uint64 unlockTime
    ) external payable nonReentrant {
        if (unlockTime <= block.timestamp) revert InvalidTime();
        if (posm.ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (locks[tokenId].active) revert AlreadyActive();
        if (posm.getApproved(tokenId) != address(this)) revert NotApproved();

        _takeAndForwardFee();

        // Mark that we expect this incoming transfer from POSM
        _expecting[tokenId] = true;
        posm.safeTransferFrom(msg.sender, address(this), tokenId);

        // Record lock terms
        locks[tokenId] = Lock({
            depositor: msg.sender,
            beneficiary: beneficiary,
            feesRecipient: beneficiary,
            unlockTime: unlockTime,
            active: true
        });

        emit Locked(tokenId, msg.sender, beneficiary, unlockTime);
    }

    // ------------------------------------------------------------
    // Core: lock with EIP-2612-like permit for POSM (gasless approval path)
    // ------------------------------------------------------------
    function lockWithPermit(
        uint256 tokenId,
        address beneficiary,
        uint64 unlockTime,
        uint256 permitDeadline,
        uint8 v, bytes32 r, bytes32 s
    ) external payable nonReentrant {
        if (unlockTime <= block.timestamp) revert InvalidTime();
        if (locks[tokenId].active) revert AlreadyActive();

        _takeAndForwardFee();

        // Permit this contract to transfer the NFT
        posm.permit(address(this), tokenId, permitDeadline, v, r, s);

        // Verify ownership and approval then pull
        address owner_ = posm.ownerOf(tokenId);
        if (owner_ != msg.sender) revert NotOwner();

        _expecting[tokenId] = true;
        posm.safeTransferFrom(owner_, address(this), tokenId);

        locks[tokenId] = Lock({
            depositor: owner_,
            beneficiary: beneficiary,
            feesRecipient: beneficiary,
            unlockTime: unlockTime,
            active: true
        });

        emit Locked(tokenId, owner_, beneficiary, unlockTime);
    }

    // ------------------------------------------------------------
    // Manage lock
    // ------------------------------------------------------------
    function extendLock(uint256 tokenId, uint64 newUnlockTime) external {
        Lock storage L = locks[tokenId];
        if (!L.active) revert NotActive();
        if (msg.sender != L.depositor) revert NotOwner();
        if (newUnlockTime <= L.unlockTime) revert InvalidTime();

        uint64 old = L.unlockTime;
        L.unlockTime = newUnlockTime;
        emit Extended(tokenId, old, newUnlockTime);
    }

    function setFeesRecipient(uint256 tokenId, address newRecipient) external {
        Lock storage L = locks[tokenId];
        if (!L.active) revert NotActive();
        if (msg.sender != L.depositor && msg.sender != L.beneficiary) revert NotOwner();

        address old = L.feesRecipient;
        L.feesRecipient = newRecipient;
        emit FeesRecipientSet(tokenId, old, newRecipient);
    }

    // ------------------------------------------------------------
    // Fee collection while locked (Uniswap position fees, not protocol fee)
    // ------------------------------------------------------------
    function collectFees(uint256 tokenId) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        Lock storage L = locks[tokenId];
        if (!L.active) revert NotActive();

        (amount0, amount1) = posm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: L.feesRecipient,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        emit FeesCollected(tokenId, L.feesRecipient, amount0, amount1);
    }

    // ------------------------------------------------------------
    // Withdraw after unlock
    // ------------------------------------------------------------
    function withdraw(uint256 tokenId, address to) external nonReentrant {
        Lock storage L = locks[tokenId];
        if (!L.active) revert NotActive();
        if (block.timestamp < L.unlockTime) revert TooSoon();
        if (msg.sender != L.beneficiary) revert NotOwner();

        L.active = false;
        posm.safeTransferFrom(address(this), to, tokenId);
        emit Withdrawn(tokenId, to);
    }

    // ------------------------------------------------------------
    // Views
    // ------------------------------------------------------------
    function isLocked(uint256 tokenId)
        external
        view
        returns (bool active, uint64 unlockTime, address beneficiary)
    {
        Lock storage L = locks[tokenId];
        return (L.active, L.unlockTime, L.beneficiary);
    }

    // ------------------------------------------------------------
    // ERC721 Receiver gate: accept only expected inbound from POSM
    // ------------------------------------------------------------
    function onERC721Received(
        address,
        address,
        uint256 tokenId,
        bytes calldata
    ) external override returns (bytes4) {
        if (msg.sender != address(posm)) revert NotPOSM();
        if (!_expecting[tokenId]) revert UnexpectedToken();
        delete _expecting[tokenId];
        return IERC721Receiver.onERC721Received.selector;
    }

    // ------------------------------------------------------------
    // Fallbacks
    // ------------------------------------------------------------
    receive() external payable {}
    fallback() external payable {}
}
