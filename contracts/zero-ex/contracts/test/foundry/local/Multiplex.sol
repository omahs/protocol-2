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

pragma solidity ^0.6;
pragma experimental ABIEncoderV2;

import "forge-std/Test.sol";
import "src/features/libs/LibSignature.sol";
import "src/features/libs/LibNativeOrder.sol";
import "src/features/interfaces/IMultiplexFeature.sol";
import "src/features/native_orders/NativeOrdersInfo.sol";
import "src/features/multiplex/MultiplexFeature.sol";
import "../utils/ForkUtils.sol";
import "../utils/TestUtils.sol";
import "../utils/DeployZeroEx.sol";
import "../../TestMintTokenERC20Transformer.sol";
import "../../tokens/TestMintableERC20Token.sol";
import "../../integration/TestUniswapV2Factory.sol";
import "../../integration/TestUniswapV2Pool.sol";
import "../../integration/TestUniswapV3Factory.sol";
import "../../integration/TestUniswapV3Pool.sol";
import "../../integration/TestLiquidityProvider.sol";

import "@0x/contracts-erc20/contracts/src/v06/WETH9V06.sol";

contract Multiplex is Test, ForkUtils, TestUtils {
    uint256 private constant MAX_UINT256 = 2 ** 256 - 1;
    uint256 private constant HIGH_BIT = 2 ** 255;
    uint24 private constant POOL_FEE = 1234;

    DeployZeroEx.ZeroExDeployed private zeroExDeployed;
    IERC20TokenV06 private shib;
    IERC20TokenV06 private dai;
    IERC20TokenV06 private zrx;
    IEtherTokenV06 private weth;

    TestUniswapV2Factory private sushiFactory;
    TestUniswapV2Factory private uniV2Factory;
    TestUniswapV3Factory private uniV3Factory;
    TestLiquidityProvider private liquidityProvider;
    uint256 private transformerNonce;

    address private signerAddress;
    uint256 private signerKey;

    function infiniteApprovals() private {
        shib.approve(address(zeroExDeployed.zeroEx), MAX_UINT256);
        dai.approve(address(zeroExDeployed.zeroEx), MAX_UINT256);
        zrx.approve(address(zeroExDeployed.zeroEx), MAX_UINT256);
        weth.approve(address(zeroExDeployed.zeroEx), MAX_UINT256);
    }

    function setUp() public {
        // TODO signer utilities shouldn't be in ForkUtils
        (signerAddress, signerKey) = getSigner();

        sushiFactory = new TestUniswapV2Factory();
        uniV2Factory = new TestUniswapV2Factory();
        uniV3Factory = new TestUniswapV3Factory();
        liquidityProvider = new TestLiquidityProvider();

        zeroExDeployed = new DeployZeroEx(
            DeployZeroEx.ZeroExDeployConfiguration({
                uniswapFactory: address(uniV2Factory),
                sushiswapFactory: address(sushiFactory),
                uniswapV3Factory: address(uniV3Factory),
                uniswapPairInitCodeHash: uniV2Factory.POOL_INIT_CODE_HASH(),
                sushiswapPairInitCodeHash: sushiFactory.POOL_INIT_CODE_HASH(),
                uniswapV3PoolInitCodeHash: uniV3Factory.POOL_INIT_CODE_HASH(),
                logDeployed: false
            })
        ).deployZeroEx();

        transformerNonce = zeroExDeployed.transformerDeployer.nonce();
        vm.prank(zeroExDeployed.transformerDeployer.authorities(0));
        zeroExDeployed.transformerDeployer.deploy(type(TestMintTokenERC20Transformer).creationCode);

        shib = IERC20TokenV06(address(new TestMintableERC20Token()));
        dai = IERC20TokenV06(address(new TestMintableERC20Token()));
        zrx = IERC20TokenV06(address(new TestMintableERC20Token()));
        weth = zeroExDeployed.weth;

        infiniteApprovals();
        vm.startPrank(signerAddress);
        infiniteApprovals();
        vm.stopPrank();

        vm.deal(address(this), 10e18);
        log_string("");
    }

    // TODO refactor some of these utility functions out into helper contract

    function makeTestRfqOrder() private returns (LibNativeOrder.RfqOrder memory order) {
        order = LibNativeOrder.RfqOrder({
            makerToken: zrx,
            takerToken: dai,
            makerAmount: 1e18,
            takerAmount: 1e18,
            maker: signerAddress,
            taker: address(this),
            txOrigin: tx.origin,
            pool: 0x0000000000000000000000000000000000000000000000000000000000000000,
            expiry: uint64(block.timestamp + 60),
            salt: 123
        });
        mintTo(address(order.makerToken), order.maker, order.makerAmount);
    }

    function makeTestOtcOrder() private returns (LibNativeOrder.OtcOrder memory order) {
        order = LibNativeOrder.OtcOrder({
            makerToken: zrx,
            takerToken: dai,
            makerAmount: 1e18,
            takerAmount: 1e18,
            maker: signerAddress,
            taker: address(this),
            txOrigin: tx.origin,
            expiryAndNonce: (uint64(block.timestamp + 60) << 192) | 1
        });
        mintTo(address(order.makerToken), order.maker, order.makerAmount);
    }

    function makeRfqSubcall(
        LibNativeOrder.RfqOrder memory order,
        uint256 sellAmount
    ) private view returns (IMultiplexFeature.BatchSellSubcall memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signerKey,
            zeroExDeployed.features.nativeOrdersFeature.getRfqOrderHash(order)
        );
        LibSignature.Signature memory sig = LibSignature.Signature(LibSignature.SignatureType.EIP712, v, r, s);

        return
            IMultiplexFeature.BatchSellSubcall({
                id: IMultiplexFeature.MultiplexSubcall.RFQ,
                sellAmount: sellAmount,
                data: abi.encode(order, sig)
            });
    }

    function makeRfqSubcall(
        LibNativeOrder.RfqOrder memory order
    ) private view returns (IMultiplexFeature.BatchSellSubcall memory) {
        return makeRfqSubcall(order, order.takerAmount);
    }

    function makeOtcSubcall(
        LibNativeOrder.OtcOrder memory order
    ) private view returns (IMultiplexFeature.BatchSellSubcall memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signerKey,
            zeroExDeployed.features.otcOrdersFeature.getOtcOrderHash(order)
        );
        LibSignature.Signature memory sig = LibSignature.Signature(LibSignature.SignatureType.EIP712, v, r, s);

        return
            IMultiplexFeature.BatchSellSubcall({
                id: IMultiplexFeature.MultiplexSubcall.OTC,
                sellAmount: order.takerAmount,
                data: abi.encode(order, sig)
            });
    }

    function makeUniswapV2MultiHopSubcall(
        address[] memory tokens,
        bool isSushi
    ) private pure returns (IMultiplexFeature.MultiHopSellSubcall memory) {
        return
            IMultiplexFeature.MultiHopSellSubcall({
                id: IMultiplexFeature.MultiplexSubcall.UniswapV2,
                data: abi.encode(tokens, isSushi)
            });
    }

    function makeUniswapV2BatchSubcall(
        address[] memory tokens,
        uint256 sellAmount,
        bool isSushi
    ) private pure returns (IMultiplexFeature.BatchSellSubcall memory) {
        return
            IMultiplexFeature.BatchSellSubcall({
                id: IMultiplexFeature.MultiplexSubcall.UniswapV2,
                sellAmount: sellAmount,
                data: abi.encode(tokens, isSushi)
            });
    }

    function encodePathUniswapV3(address[] memory tokens) private pure returns (bytes memory path) {
        path = new bytes(tokens.length * 23 - 3);
        for (uint256 i = 0; i < tokens.length; i++) {
            assembly {
                let p := add(add(path, 32), mul(i, 23))
                if gt(i, 0) {
                    mstore(sub(p, 3), shl(232, POOL_FEE))
                }

                let a := add(add(tokens, 32), mul(i, 32))
                mstore(p, shl(96, mload(a)))
            }
        }
    }

    function makeUniswapV3MultiHopSubcall(
        address[] memory tokens
    ) private pure returns (IMultiplexFeature.MultiHopSellSubcall memory) {
        return
            IMultiplexFeature.MultiHopSellSubcall({
                id: IMultiplexFeature.MultiplexSubcall.UniswapV3,
                data: encodePathUniswapV3(tokens)
            });
    }

    function makeUniswapV3BatchSubcall(
        address[] memory tokens,
        uint256 sellAmount
    ) private pure returns (IMultiplexFeature.BatchSellSubcall memory) {
        return
            IMultiplexFeature.BatchSellSubcall({
                id: IMultiplexFeature.MultiplexSubcall.UniswapV3,
                sellAmount: sellAmount,
                data: encodePathUniswapV3(tokens)
            });
    }

    function makeLiquidityProviderBatchSubcall(
        uint256 sellAmount
    ) private view returns (IMultiplexFeature.BatchSellSubcall memory) {
        return
            IMultiplexFeature.BatchSellSubcall({
                id: IMultiplexFeature.MultiplexSubcall.LiquidityProvider,
                sellAmount: sellAmount,
                data: abi.encode(address(liquidityProvider), hex"")
            });
    }

    function makeTransformERC20Subcall(
        IERC20TokenV06 inputToken,
        IERC20TokenV06 outputToken,
        uint256 sellAmount,
        uint256 mintAmount
    ) private view returns (IMultiplexFeature.BatchSellSubcall memory) {
        ITransformERC20Feature.Transformation[] memory transformations = new ITransformERC20Feature.Transformation[](1);
        transformations[0] = ITransformERC20Feature.Transformation(
            uint32(transformerNonce),
            abi.encode(address(inputToken), address(outputToken), 0, mintAmount, 0)
        );

        return
            IMultiplexFeature.BatchSellSubcall({
                id: IMultiplexFeature.MultiplexSubcall.TransformERC20,
                sellAmount: sellAmount,
                data: abi.encode(transformations)
            });
    }

    function makeNestedMultiHopSubcall(
        address[] memory tokens,
        IMultiplexFeature.MultiHopSellSubcall[] memory calls,
        uint256 sellAmount
    ) private pure returns (IMultiplexFeature.BatchSellSubcall memory) {
        return
            IMultiplexFeature.BatchSellSubcall({
                id: IMultiplexFeature.MultiplexSubcall.MultiHopSell,
                sellAmount: sellAmount,
                data: abi.encode(tokens, calls)
            });
    }

    function makeArray(
        IMultiplexFeature.MultiHopSellSubcall memory first,
        IMultiplexFeature.MultiHopSellSubcall memory second
    ) private pure returns (IMultiplexFeature.MultiHopSellSubcall[] memory subcalls) {
        subcalls = new IMultiplexFeature.MultiHopSellSubcall[](2);
        subcalls[0] = first;
        subcalls[1] = second;
    }

    function makeArray(
        IMultiplexFeature.BatchSellSubcall memory first
    ) private pure returns (IMultiplexFeature.BatchSellSubcall[] memory subcalls) {
        subcalls = new IMultiplexFeature.BatchSellSubcall[](1);
        subcalls[0] = first;
    }

    function makeArray(
        IMultiplexFeature.BatchSellSubcall memory first,
        IMultiplexFeature.BatchSellSubcall memory second
    ) private pure returns (IMultiplexFeature.BatchSellSubcall[] memory subcalls) {
        subcalls = new IMultiplexFeature.BatchSellSubcall[](2);
        subcalls[0] = first;
        subcalls[1] = second;
    }

    function makeArray(
        IMultiplexFeature.BatchSellSubcall memory first,
        IMultiplexFeature.BatchSellSubcall memory second,
        IMultiplexFeature.BatchSellSubcall memory third
    ) private pure returns (IMultiplexFeature.BatchSellSubcall[] memory subcalls) {
        subcalls = new IMultiplexFeature.BatchSellSubcall[](3);
        subcalls[0] = first;
        subcalls[1] = second;
        subcalls[2] = third;
    }

    function makeArray(address first) private pure returns (address[] memory addresses) {
        addresses = new address[](1);
        addresses[0] = first;
    }

    function makeArray(address first, address second) private pure returns (address[] memory addresses) {
        addresses = new address[](2);
        addresses[0] = first;
        addresses[1] = second;
    }

    function makeArray(address first, address second, address third) private pure returns (address[] memory addresses) {
        addresses = new address[](3);
        addresses[0] = first;
        addresses[1] = second;
        addresses[2] = third;
    }

    function mintTo(address token, address recipient, uint256 amount) private {
        if (token == address(weth)) {
            IEtherTokenV06(token).deposit{value: amount}();
            WETH9V06(payable(token)).transfer(recipient, amount);
        } else {
            TestMintableERC20Token(token).mint(recipient, amount);
        }
    }

    function createUniswapV2Pool(
        TestUniswapV2Factory factory,
        IERC20TokenV06 tokenA,
        IERC20TokenV06 tokenB,
        uint112 balanceA,
        uint112 balanceB
    ) private returns (TestUniswapV2Pool pool) {
        pool = factory.createPool(tokenA, tokenB);
        mintTo(address(tokenA), address(pool), balanceA);
        mintTo(address(tokenB), address(pool), balanceB);

        (uint112 balance0, uint112 balance1) = tokenA < tokenB ? (balanceA, balanceB) : (balanceB, balanceA);
        pool.setReserves(balance0, balance1, 0);
    }

    function createUniswapV3Pool(
        TestUniswapV3Factory factory,
        IERC20TokenV06 tokenA,
        IERC20TokenV06 tokenB,
        uint112 balanceA,
        uint112 balanceB
    ) private returns (TestUniswapV3Pool pool) {
        pool = factory.createPool(tokenA, tokenB, POOL_FEE);
        mintTo(address(tokenA), address(pool), balanceA);
        mintTo(address(tokenB), address(pool), balanceB);
    }

    function encodeFractionalFillAmount(uint256 frac) private pure returns (uint256) {
        return HIGH_BIT + (frac * 1e16);
    }

    // TODO refactor these out into some test utility contract

    uint256 private snapshot;

    function snap() private {
        if (snapshot != 0) vm.revertTo(snapshot);
        snapshot = vm.snapshot();
    }

    function describe(string memory message) private {
        log_string(message);
        snap();
    }

    function it(string memory message) private {
        log_string(string(abi.encodePacked("  ├─ ", message)));
        snap();
    }

    function it(string memory message, bool last) private {
        if (last) {
            log_string(string(abi.encodePacked("  └─ ", message)));
            snap();
        } else it(message);
    }

    //// batch sells

    function test_MultiplexBatchSellTokenForToken() public {
        describe("MultiplexBatchSellTokenForToken");

        ////
        {
            it("reverts if minBuyAmount is not satisfied");

            LibNativeOrder.RfqOrder memory rfqOrder = makeTestRfqOrder();
            mintTo(address(rfqOrder.takerToken), rfqOrder.taker, rfqOrder.takerAmount);

            try
                zeroExDeployed.zeroEx.multiplexBatchSellTokenForToken(
                    dai,
                    zrx,
                    makeArray(makeRfqSubcall(rfqOrder)),
                    rfqOrder.takerAmount,
                    rfqOrder.makerAmount + 1
                )
            {
                fail("did not revert");
            } catch Error(string memory reason) {
                assertEq(reason, "MultiplexFeature::_multiplexBatchSell/UNDERBOUGHT", "wrong revert reason");
            } catch {
                fail("low-level revert");
            }
        }

        ////
        {
            it("reverts if given an invalid subcall type");

            uint256 sellAmount = 1;

            try
                zeroExDeployed.zeroEx.multiplexBatchSellTokenForToken(
                    dai,
                    zrx,
                    makeArray(
                        IMultiplexFeature.BatchSellSubcall({
                            id: IMultiplexFeature.MultiplexSubcall.Invalid,
                            sellAmount: sellAmount,
                            data: hex""
                        })
                    ),
                    sellAmount,
                    0
                )
            {
                fail("did not revert");
            } catch Error(string memory reason) {
                assertEq(reason, "MultiplexFeature::_executeBatchSell/INVALID_SUBCALL", "wrong revert reason");
            } catch {
                fail("low-level revert");
            }
        }

        ////
        {
            it("reverts if the full sell amount is not sold");

            LibNativeOrder.RfqOrder memory rfqOrder = makeTestRfqOrder();
            mintTo(address(rfqOrder.takerToken), rfqOrder.taker, rfqOrder.takerAmount);

            try
                zeroExDeployed.zeroEx.multiplexBatchSellTokenForToken(
                    rfqOrder.takerToken,
                    rfqOrder.makerToken,
                    makeArray(makeRfqSubcall(rfqOrder)),
                    rfqOrder.takerAmount + 1,
                    rfqOrder.makerAmount
                )
            {
                fail("did not revert");
            } catch Error(string memory reason) {
                assertEq(reason, "MultiplexFeature::_executeBatchSell/INCORRECT_AMOUNT_SOLD", "wrong revert reason");
            } catch {
                fail("low-level revert");
            }
        }

        ////
        {
            it("RFQ, fallback(UniswapV2)");

            LibNativeOrder.RfqOrder memory rfqOrder = makeTestRfqOrder();
            createUniswapV2Pool(uniV2Factory, dai, zrx, 10e18, 10e18);
            mintTo(address(rfqOrder.takerToken), rfqOrder.taker, rfqOrder.takerAmount);

            try
                zeroExDeployed.zeroEx.multiplexBatchSellTokenForToken(
                    rfqOrder.takerToken,
                    zrx,
                    makeArray(
                        makeRfqSubcall(rfqOrder),
                        makeUniswapV2BatchSubcall(makeArray(address(dai), address(zrx)), rfqOrder.takerAmount, false)
                    ),
                    rfqOrder.takerAmount,
                    0
                )
            {
                // TODO verify rfqOrder was filled
            } catch Error(string memory reason) {
                fail("reverted");
                fail(reason);
            } catch {
                fail("low-level revert");
            }
        }

        ////
        {
            it("OTC, fallback(UniswapV2)");

            LibNativeOrder.OtcOrder memory otcOrder = makeTestOtcOrder();
            createUniswapV2Pool(uniV2Factory, dai, zrx, 10e18, 10e18);
            mintTo(address(otcOrder.takerToken), otcOrder.taker, otcOrder.takerAmount);

            try
                zeroExDeployed.zeroEx.multiplexBatchSellTokenForToken(
                    otcOrder.takerToken,
                    zrx,
                    makeArray(
                        makeOtcSubcall(otcOrder),
                        makeUniswapV2BatchSubcall(makeArray(address(dai), address(zrx)), otcOrder.takerAmount, false)
                    ),
                    otcOrder.takerAmount,
                    0
                )
            {
                // TODO verify otcOrder was filled
            } catch Error(string memory reason) {
                fail("reverted");
                fail(reason);
            } catch {
                fail("low-level revert");
            }
        }

        ////
        {
            it("expired RFQ, fallback(UniswapV2)");

            LibNativeOrder.RfqOrder memory rfqOrder = makeTestRfqOrder();
            createUniswapV2Pool(uniV2Factory, dai, zrx, 10e18, 10e18);
            mintTo(address(rfqOrder.takerToken), rfqOrder.taker, rfqOrder.takerAmount);
            rfqOrder.expiry = 0;

            try
                zeroExDeployed.zeroEx.multiplexBatchSellTokenForToken(
                    rfqOrder.takerToken,
                    zrx,
                    makeArray(
                        makeRfqSubcall(rfqOrder),
                        makeUniswapV2BatchSubcall(makeArray(address(dai), address(zrx)), rfqOrder.takerAmount, false)
                    ),
                    rfqOrder.takerAmount,
                    0
                )
            {
                // TODO verify rfqOrder expired, verify fallback to uniswapV2 transferred correctly
            } catch Error(string memory reason) {
                fail("reverted");
                fail(reason);
            } catch {
                fail("low-level revert");
            }
        }

        ////
        {
            it("expired OTC, fallback(UniswapV2)");

            LibNativeOrder.OtcOrder memory otcOrder = makeTestOtcOrder();
            createUniswapV2Pool(uniV2Factory, dai, zrx, 10e18, 10e18);
            mintTo(address(otcOrder.takerToken), otcOrder.taker, otcOrder.takerAmount);
            otcOrder.expiryAndNonce = 1;

            try
                zeroExDeployed.zeroEx.multiplexBatchSellTokenForToken(
                    otcOrder.takerToken,
                    zrx,
                    makeArray(
                        makeOtcSubcall(otcOrder),
                        makeUniswapV2BatchSubcall(makeArray(address(dai), address(zrx)), otcOrder.takerAmount, false)
                    ),
                    otcOrder.takerAmount,
                    0
                )
            {
                // TODO verify otcOrder expired, verify fallback to uniswapV2 transferred correctly
            } catch Error(string memory reason) {
                fail("reverted");
                fail(reason);
            } catch {
                fail("low-level revert");
            }
        }

        ////
        {
            it("expired RFQ, fallback(TransformERC20)");

            LibNativeOrder.RfqOrder memory rfqOrder = makeTestRfqOrder();
            mintTo(address(rfqOrder.takerToken), rfqOrder.taker, rfqOrder.takerAmount);
            rfqOrder.expiry = 0;

            try
                zeroExDeployed.zeroEx.multiplexBatchSellTokenForToken(
                    rfqOrder.takerToken,
                    zrx,
                    makeArray(
                        makeRfqSubcall(rfqOrder),
                        makeTransformERC20Subcall(dai, zrx, rfqOrder.takerAmount, 5e17)
                    ),
                    rfqOrder.takerAmount,
                    0
                )
            {
                // TODO verify rfqOrder expired, verify fallback to transformERC20 transferred correctly
            } catch Error(string memory reason) {
                fail("reverted");
                fail(reason);
            } catch {
                fail("low-level revert");
            }
        }

        ////
        {
            it("LiquidityProvider, UniV3, Sushiswap");

            createUniswapV2Pool(sushiFactory, dai, zrx, 10e18, 10e18);
            createUniswapV3Pool(uniV3Factory, dai, zrx, 10e18, 10e18);

            address[] memory tokens = makeArray(address(dai), address(zrx));
            IMultiplexFeature.BatchSellSubcall memory lpSubcall = makeLiquidityProviderBatchSubcall(4e17);
            IMultiplexFeature.BatchSellSubcall memory uniV3Subcall = makeUniswapV3BatchSubcall(tokens, 5e17);
            IMultiplexFeature.BatchSellSubcall memory sushiswapSubcall = makeUniswapV2BatchSubcall(tokens, 6e17, true);
            uint256 sellAmount = lpSubcall.sellAmount + uniV3Subcall.sellAmount + sushiswapSubcall.sellAmount;

            mintTo(address(dai), address(this), sellAmount);

            try
                zeroExDeployed.zeroEx.multiplexBatchSellTokenForToken(
                    dai,
                    zrx,
                    makeArray(lpSubcall, uniV3Subcall, sushiswapSubcall),
                    sellAmount,
                    0
                )
            {
                // TODO verify all the tokens were transferred to/from the correct places
            } catch Error(string memory reason) {
                fail("reverted");
                fail(reason);
            } catch {
                fail("low-level revert");
            }
        }

        ////
        {
            it("proportional fill amounts");

            createUniswapV2Pool(uniV2Factory, dai, zrx, 10e18, 10e18);

            uint256 sellAmount = 1e18;
            mintTo(address(dai), address(this), sellAmount);

            try
                zeroExDeployed.zeroEx.multiplexBatchSellTokenForToken(
                    dai,
                    zrx,
                    makeArray(
                        makeRfqSubcall(makeTestRfqOrder(), encodeFractionalFillAmount(42)),
                        makeUniswapV2BatchSubcall(
                            makeArray(address(dai), address(zrx)),
                            encodeFractionalFillAmount(100),
                            false
                        )
                    ),
                    sellAmount,
                    0
                )
            {
                // TODO verify correct proportions were transferred
            } catch Error(string memory reason) {
                fail("reverted");
                fail(reason);
            } catch {
                fail("low-level revert");
            }
        }

        ////
        {
            it("RFQ, MultiHop(UniV3, UniV2)", true);

            createUniswapV2Pool(uniV2Factory, shib, zrx, 10e18, 10e18);
            createUniswapV3Pool(uniV3Factory, dai, shib, 10e18, 10e18);

            IMultiplexFeature.BatchSellSubcall memory rfqSubcall = makeRfqSubcall(makeTestRfqOrder());
            IMultiplexFeature.BatchSellSubcall memory multiHopSubcall = makeNestedMultiHopSubcall(
                makeArray(address(dai), address(shib), address(zrx)),
                makeArray(
                    makeUniswapV3MultiHopSubcall(makeArray(address(dai), address(shib))),
                    makeUniswapV2MultiHopSubcall(makeArray(address(shib), address(zrx)), false)
                ),
                5e17
            );

            uint256 sellAmount = rfqSubcall.sellAmount + multiHopSubcall.sellAmount;
            mintTo(address(dai), address(this), sellAmount);

            try
                zeroExDeployed.zeroEx.multiplexBatchSellTokenForToken(
                    dai,
                    zrx,
                    makeArray(rfqSubcall, multiHopSubcall),
                    sellAmount,
                    0
                )
            {
                // TODO verify all the tokens were transferred to/from the correct places
            } catch Error(string memory reason) {
                fail("reverted");
                fail(reason);
            } catch {
                fail("low-level revert");
            }
        }
    }

    function testMultiplexBatchSellEthForToken() public {
        // RFQ
        // OTC
        // UniswapV2
        // UniswapV3
        // LiquidityProvider
        // TransformERC20
        // RFQ, MultiHop(UniV3, UniV2)
    }

    function testMultiplexBatchSellTokenForEth() public {
        // RFQ
        // OTC
        // UniswapV2
        // UniswapV3
        // LiquidityProvider
        // TransformERC20
        // RFQ, MultiHop(UniV3, UniV2)
    }

    //// multihop sells

    function testMultiplexMultihopSellTokenForToken() public {
        // reverts if given an invalid subcall type
        // reverts if minBuyAmount is not satisfied
        // reverts if array lengths are mismatched
        // UniswapV2 -> LiquidityProvider
        // LiquidityProvider -> Sushiswap
        // UniswapV3 -> BatchSell(RFQ, UniswapV2)
        // BatchSell(RFQ, UniswapV2) -> UniswapV3
    }

    function testMultiplexMultiHopSellEthForToken() public {
        // reverts if first token is not WETH
        // UniswapV2 -> LiquidityProvider
        // LiquidityProvider -> Sushiswap
        // UniswapV3 -> BatchSell(RFQ, UniswapV2)
        // BatchSell(RFQ, UniswapV2) -> UniswapV3
    }

    function testMultiplexMultiHopSellTokenForEth() public {
        // reverts if last token is not WETH
        // UniswapV2 -> LiquidityProvider
        // LiquidityProvider -> Sushiswap
        // UniswapV3 -> BatchSell(RFQ, UniswapV2)
        // BatchSell(RFQ, UniswapV2) -> UniswapV3
    }
}
