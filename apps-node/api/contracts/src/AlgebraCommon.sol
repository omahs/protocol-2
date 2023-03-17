// SPDX-License-Identifier: Apache-2.0
/*

  Copyright 2022 ZeroEx Intl.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.

*/

pragma solidity >=0.6;
pragma experimental ABIEncoderV2;

import "./interfaces/IAlgebra.sol";
import "./interfaces/IMultiQuoter.sol";
import "./TickBasedAMMCommon.sol";

contract AlgebraCommon is TickBasedAMMCommon {
    function toAlgebraPath(address[] memory tokenPath) internal pure returns (bytes memory algebraPath) {
        require(tokenPath.length >= 2, "AlgebraCommon/invalid path lengths");

        // Algebra paths are tightly packed as
        // [token0, token1, token2, ... ]
        algebraPath = new bytes(tokenPath.length * 20);
        uint256 o;
        assembly {
            o := add(algebraPath, 32)
        }
        for (uint256 i = 0; i < tokenPath.length; ++i) {
            address token = tokenPath[i];
            assembly {
                mstore(o, shl(96, token))
                o := add(o, 20)
            }
        }
    }

    function isValidTokenPath(address factory, address[] memory tokenPath) internal view returns (bool) {
        for (uint256 i = 0; i < tokenPath.length - 1; ++i) {
            address pool = IAlgebraFactory(factory).poolByPair(tokenPath[i], tokenPath[i + 1]);
            if (pool == address(0)) {
                return false;
            }
        }
        return true;
    }
}
