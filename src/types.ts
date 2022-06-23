import { OtcOrder, Signature } from '@0x/protocol-utils';
import { BigNumber } from '@0x/utils';

export type RequireOnlyOne<T, Keys extends keyof T = keyof T> = Pick<T, Exclude<keyof T, Keys>> &
    {
        [K in Keys]-?: Required<Pick<T, K>> & Partial<Record<Exclude<Keys, K>, undefined>>;
    }[Keys];

export interface IndicativeQuote {
    maker: string;
    makerUri: string;
    makerToken: string;
    takerToken: string;
    makerAmount: BigNumber;
    takerAmount: BigNumber;
    expiry: BigNumber;
}

/**
 * FirmOtcQuote is a quote for an OtcOrder. The makerSignature may not be present if the maker gets
 * the "last look" (RFQm).
 */
export interface FirmOtcQuote {
    kind: 'otc';
    makerUri: string;
    order: OtcOrder;
    makerSignature?: Signature;
}

export type QuoteServerPriceParams = RequireOnlyOne<
    {
        buyAmountBaseUnits?: string;
        buyTokenAddress: string;
        chainId?: string; // TODO - make this required after the rollout
        comparisonPrice?: string;
        feeAmount?: string;
        feeToken?: string;
        feeType?: string;
        isLastLook?: string;
        integratorId?: string;
        nonce?: string;
        nonceBucket?: string;
        protocolVersion?: string;
        sellAmountBaseUnits?: string;
        sellTokenAddress: string;
        takerAddress: string;
        txOrigin?: string;
    },
    'sellAmountBaseUnits' | 'buyAmountBaseUnits'
>;
export interface TokenMetadata {
    symbol: string;
    decimals: number;
    tokenAddress: string;
}

export enum OrderEventEndState {
    // The order was successfully validated and added to the Mesh node. The order is now being watched and any changes to
    // the fillability will result in subsequent order events.
    Added = 'ADDED',
    // The order was filled for a partial amount. The order is still fillable up to the fillableTakerAssetAmount.
    Filled = 'FILLED',
    // The order was fully filled and its remaining fillableTakerAssetAmount is 0. The order is no longer fillable.
    FullyFilled = 'FULLY_FILLED',
    // The order was cancelled and is no longer fillable.
    Cancelled = 'CANCELLED',
    // The order expired and is no longer fillable.
    Expired = 'EXPIRED',
    // Catch all 'Invalid' state when invalid orders are submitted.
    Invalid = 'INVALID',
    // The order was previously expired, but due to a block re-org it is no longer considered expired (should be rare).
    Unexpired = 'UNEXPIRED',
    // The order has become unfunded and is no longer fillable. This can happen if the maker makes a transfer or changes their allowance.
    Unfunded = 'UNFUNDED',
    // The fillability of the order has increased. This can happen if a previously processed fill event gets reverted due to a block re-org,
    // or if a maker makes a transfer or changes their allowance.
    FillabilityIncreased = 'FILLABILITY_INCREASED',
    // The order is potentially still valid but was removed for a different reason (e.g.
    // the database is full or the peer that sent the order was misbehaving). The order will no longer be watched
    // and no further events for this order will be emitted. In some cases, the order may be re-added in the
    // future.
    StoppedWatching = 'STOPPED_WATCHING',
}

// tslint:disable-line:max-file-line-count
