// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BaseRelayRecipient.sol";

/**
 * @title Storage
 * @dev Guarda y recupera un valor uint256. Adaptado al modelo de gas de
 *      LNet: hereda BaseRelayRecipient y usa _msgSender() en lugar
 *      de msg.sender para resolver el sender original tras el relay.
 */
contract Storage is BaseRelayRecipient {
    uint256 private value;
    address public owner;

    event ValueChanged(address indexed sender, uint256 newValue);

    constructor(address trustedForwarder_) BaseRelayRecipient(trustedForwarder_) {
        owner = _msgSender(); // en vez de msg.sender
    }

    function store(uint256 newValue) public {
        value = newValue;
        emit ValueChanged(_msgSender(), newValue); // en vez de msg.sender
    }

    function retrieve() public view returns (uint256) {
        return value;
    }
}
