// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.0 <0.9.0;

/**
 * @title BaseRelayRecipient
 * @dev Contrato base que todo contrato desplegado en LNet debe heredar
 *      para funcionar con el modelo de gas (relay). Las transacciones llegan al
 *      contrato firmadas por el RelayHub, no por el usuario original; este contrato
 *      recupera el sender real consultando al trustedForwarder.
 *
 *      Toda subclase debe usar `_msgSender()` en lugar de `msg.sender`.
 */
abstract contract BaseRelayRecipient {
    /// @dev Forwarder de confianza desde el cual aceptamos llamadas relayed.
    address internal trustedForwarder;

    constructor(address trustedForwarder_) {
        trustedForwarder = trustedForwarder_;
    }

    /**
     * @dev Devuelve el sender de la llamada. Si vino a través del RelayHub,
     *      devuelve el sender original; en otro caso, msg.sender.
     */
    function _msgSender() internal view virtual returns (address sender) {
        bytes memory bytesRelayHub;
        (, bytesRelayHub) = trustedForwarder.staticcall(
            abi.encodeWithSignature("getRelayHub()")
        );

        if (msg.sender == abi.decode(bytesRelayHub, (address))) {
            bytes memory bytesSender;
            (, bytesSender) = trustedForwarder.staticcall(
                abi.encodeWithSignature("getMsgSender()")
            );
            return abi.decode(bytesSender, (address));
        } else {
            return msg.sender;
        }
    }
}
