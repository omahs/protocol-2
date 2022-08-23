import { MetaTransaction } from '@0x/protocol-utils';
import { BigNumber } from '@0x/utils';
import Axios, { AxiosInstance } from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';
import { BAD_REQUEST, NOT_ACCEPTABLE, OK } from 'http-status-codes';

import { getQuoteAsync } from '../../src/utils/MetaTransactionClient';

let axiosClient: AxiosInstance;
let axiosMock: AxiosMockAdapter;

describe('MetaTransactionClient', () => {
    beforeAll(() => {
        axiosClient = Axios.create();
        axiosMock = new AxiosMockAdapter(axiosClient);
    });
    describe('getQuoteAsync', () => {
        it('should get a metatransaction quote', async () => {
            const exampleSuccessfulResponse = {
                allowanceTarget: '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
                buyAmount: '1800054805473',
                buyTokenAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
                buyTokenToEthRate: '0.851202',
                chainId: 137,
                estimatedGas: '1043459',
                estimatedPriceImpact: '1.6301',
                gas: '1043459',
                gasPrice: '115200000000',
                minimumProtocolFee: '0',
                mtx: {
                    callData:
                        '0x415565b00000000000000000000000007ceb23fd6bc0add59e62ac25578270cff1b9f6190000000000000000000000002791bca1f2de4661ed88a30c99a7a9449aa8417400000000000000000000000000000000000000000000003635c9adc5dea000000000000000000000000000000000000000000000000000000000019eeab6030b00000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000940000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000008a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007ceb23fd6bc0add59e62ac25578270cff1b9f6190000000000000000000000002791bca1f2de4661ed88a30c99a7a9449aa8417400000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000860000000000000000000000000000000000000000000000000000000000000086000000000000000000000000000000000000000000000000000000000000007c000000000000000000000000000000000000000000000003635c9adc5dea000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000003400000000000000000000000000000000000000000000000000000000000000420000000000000000000000000000000000000000000000000000000000000052000000000000000000000000000000002517569636b5377617000000000000000000000000000000000000000000000000000000000000008570b55cfac1897880000000000000000000000000000000000000000000000000000003f47a215c5000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000a5e0829caced8ffdd4de3c43696c57f7d7a678ff000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000020000000000000000000000007ceb23fd6bc0add59e62ac25578270cff1b9f6190000000000000000000000002791bca1f2de4661ed88a30c99a7a9449aa8417400000000000000000000000000000002517569636b53776170000000000000000000000000000000000000000000000000000000000000042b85aae7d60c4bc40000000000000000000000000000000000000000000000000000001f2c6f738e000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000a5e0829caced8ffdd4de3c43696c57f7d7a678ff000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000030000000000000000000000007ceb23fd6bc0add59e62ac25578270cff1b9f6190000000000000000000000000d500b1d8e8ef31e21c99d1db9a6444d3adf12700000000000000000000000002791bca1f2de4661ed88a30c99a7a9449aa841740000000000000000000000000000000b446f646f5632000000000000000000000000000000000000000000000000000000000000000000042b85aae7d60c4bc40000000000000000000000000000000000000000000000000000001f811895a7000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000400000000000000000000000005333eb1e32522f1893b7c9fea3c263807a02d561000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000012556e697377617056330000000000000000000000000000000000000000000000000000000000001d30a7ac56da56396a000000000000000000000000000000000000000000000000000000e10b7768e500000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000060000000000000000000000000e592427a0aece92de3edee1f18e0157c058615640000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000012556e6973776170563300000000000000000000000000000000000000000000000000000000000008570b55cfac1897880000000000000000000000000000000000000000000000000000003fea147b29000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000e592427a0aece92de3edee1f18e0157c05861564000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000427ceb23fd6bc0add59e62ac25578270cff1b9f6190001f41bfd67037b42cf73acf2047067bd4f2c47d9bfd6000bb82791bca1f2de4661ed88a30c99a7a9449aa841740000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000020000000000000000000000007ceb23fd6bc0add59e62ac25578270cff1b9f619000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0000000000000000000000000000000000000000000000000000000000000000869584cd0000000000000000000000008c611defbd838a13de3a5923693c58a7c1807c630000000000000000000000000000000000000000000000f789bac21b62fed5ef',
                    domain: {
                        chainId: 137,
                        verifyingContract: '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
                    },
                    expirationTimeSeconds: '1660868679',
                    feeAmount: '0',
                    feeToken: '0x0000000000000000000000000000000000000000',
                    maxGasPrice: '4294967296',
                    minGasPrice: '1',
                    salt: '32606650794224189614795510724011106220035660490560169776986607186708081701146',
                    sender: '0x0000000000000000000000000000000000000000',
                    signer: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
                    value: '0',
                },
                mtxHash: '0x16688406783c0e721a69e5c9f2727e2d30f24a0669522c1fb6937460348b4095',
                price: '1800.054805',
                protocolFee: '0',
                sellAmount: '1000000000000000000000',
                sellTokenAddress: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
                sellTokenToEthRate: '0.000465167371348443',
                sources: [
                    {
                        name: 'SushiSwap',
                        proportion: '0',
                    },
                    {
                        name: 'QuickSwap',
                        proportion: '0.2308',
                    },
                    {
                        name: 'DODO_V2',
                        proportion: '0.07692',
                    },
                    {
                        name: 'Uniswap_V3',
                        proportion: '0.6923',
                    },
                ],
                value: '0',
            };

            const url = new URL('https://quoteserver.pizza/quote');

            axiosMock.onGet(url.toString()).replyOnce(OK, exampleSuccessfulResponse);

            const response = await getQuoteAsync(axiosClient, url, {
                buyToken: 'USDC',
                sellToken: 'WETH',
                sellAmount: new BigNumber(1000000000000000000000),
                takerAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
            });

            expect(response?.metaTransaction).toBeInstanceOf(MetaTransaction);
            expect(response?.metaTransaction.getHash()).toEqual(exampleSuccessfulResponse.mtxHash);
            expect(response?.quote).toEqual({
                buyAmount: exampleSuccessfulResponse.buyAmount,
                buyTokenAddress: exampleSuccessfulResponse.buyTokenAddress,
                gas: exampleSuccessfulResponse.gas,
                price: exampleSuccessfulResponse.price,
                sellAmount: exampleSuccessfulResponse.sellAmount,
                sellTokenAddress: exampleSuccessfulResponse.sellTokenAddress,
            });
        });

        it('should return `null` when no liquidity is available', async () => {
            const exampleNoLiquidityResponse = {
                code: 100,
                reason: 'Validation Failed',
                validationErrors: [
                    {
                        field: 'sellAmount',
                        code: 1004,
                        reason: 'INSUFFICIENT_ASSET_LIQUIDITY',
                    },
                ],
            };

            const url = new URL('https://quoteserver.pizza/quote');

            axiosMock.onGet(url.toString()).replyOnce(BAD_REQUEST, exampleNoLiquidityResponse);

            const response = await getQuoteAsync(axiosClient, url, {
                buyToken: 'USDC',
                sellToken: '0x0000000000000000000000000000000000000000',
                sellAmount: new BigNumber(1000000000000000000000),
                takerAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
            });

            expect(response).toBeNull();
        });

        it("should throw an error if the response doesn't match the no liquidity response", async () => {
            const url = new URL('https://quoteserver.pizza/quote');

            axiosMock.onGet(url.toString()).replyOnce(NOT_ACCEPTABLE);

            await expect(() =>
                getQuoteAsync(axiosClient, url, {
                    buyToken: 'USDC',
                    sellToken: '0x0000000000000000000000000000000000000000',
                    sellAmount: new BigNumber(1000000000000000000000),
                    takerAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
                }),
            ).rejects.toThrow();
        });
    });
});
