// tslint:disable:max-file-line-count
import { TooManyRequestsError } from '@0x/api-utils';
import { AssetSwapperContractAddresses, MarketOperation } from '@0x/asset-swapper';
import { OtcOrder, Signature } from '@0x/protocol-utils';
import { Fee, SignRequest } from '@0x/quote-server/lib/src/types';
import {
    getTokenMetadataIfExists,
    nativeTokenSymbol,
    nativeWrappedTokenSymbol,
    TokenMetadata,
} from '@0x/token-metadata';
import { BigNumber } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import { retry } from '@lifeomic/attempt';
import delay from 'delay';
import { Producer as KafkaProducer } from 'kafkajs';
import * as _ from 'lodash';
import { Counter, Gauge, Summary } from 'prom-client';
import { Producer } from 'sqs-producer';

import { Integrator, RFQM_MAINTENANCE_MODE, RFQM_WORKER_INDEX } from '../config';
import {
    ETH_DECIMALS,
    GWEI_DECIMALS,
    NULL_ADDRESS,
    ONE_MINUTE_S,
    ONE_SECOND_MS,
    RFQM_MINIMUM_EXPIRY_DURATION_MS,
    RFQM_NUM_BUCKETS,
} from '../constants';
import { RfqmV2JobEntity, RfqmV2TransactionSubmissionEntity } from '../entities';
import { RfqmV2JobConstructorOpts } from '../entities/RfqmV2JobEntity';
import { RfqmJobStatus, RfqmTransactionSubmissionStatus } from '../entities/types';
import { InternalServerError, NotFoundError, ValidationError, ValidationErrorCodes } from '../errors';
import { logger } from '../logger';
import { FirmOtcQuote, IndicativeQuote } from '../types';
import { CacheClient } from '../utils/cache_client';
import { ConfigManager } from '../utils/config_manager';
import { getBestQuote } from '../utils/quote_comparison_utils';
import { quoteReportUtils } from '../utils/quote_report_utils';
import { QuoteServerClient } from '../utils/quote_server_client';
import {
    feeToStoredFee,
    otcOrderToStoredOtcOrder,
    RfqmDbUtils,
    storedFeeToFee,
    storedOtcOrderToOtcOrder,
} from '../utils/rfqm_db_utils';
import { computeHealthCheckAsync, HealthCheckResult } from '../utils/rfqm_health_check';
import { RfqBlockchainUtils } from '../utils/rfq_blockchain_utils';
import { RfqMakerManager } from '../utils/rfq_maker_manager';
import { getSignerFromHash, padSignature } from '../utils/signature_utils';
import { SubmissionContext } from '../utils/SubmissionContext';

import { RfqmFeeService } from './rfqm_fee_service';
import {
    FetchFirmQuoteParams,
    FetchIndicativeQuoteParams,
    FetchIndicativeQuoteResponse,
    OtcOrderRfqmQuoteResponse,
    OtcOrderSubmitRfqmSignedQuoteParams,
    OtcOrderSubmitRfqmSignedQuoteResponse,
    RfqmTypes,
    StatusResponse,
} from './types';

export const BLOCK_FINALITY_THRESHOLD = 3;
const MIN_GAS_PRICE_INCREASE = 0.1;

interface GasFees {
    maxFeePerGas: BigNumber;
    maxPriorityFeePerGas: BigNumber;
}

const RFQM_QUOTE_INSERTED = new Counter({
    name: 'rfqm_quote_inserted',
    help: 'An RfqmQuote was inserted in the DB',
    labelNames: ['apiKey', 'integratorId', 'makerUri'],
});

const RFQM_WORKER_BALANCE = new Gauge({
    name: 'rfqm_worker_balance',
    labelNames: ['address', 'chain_id'],
    help: 'Worker balance for RFQM',
});

const RFQM_WORKER_READY = new Counter({
    name: 'rfqm_worker_ready',
    labelNames: ['address', 'chain_id'],
    help: 'A worker passed the readiness check, and is ready to pick up work',
});

const RFQM_WORKER_NOT_READY = new Counter({
    name: 'rfqm_worker_not_ready',
    labelNames: ['address', 'chain_id'],
    help: 'A worker did not pass the readiness check, and was not able to pick up work',
});

const RFQM_JOB_REPAIR = new Gauge({
    name: 'rfqm_job_to_repair',
    labelNames: ['address', 'chain_id'],
    help: 'A submitted job failed and started repair mode',
});

const RFQM_SIGNED_QUOTE_NOT_FOUND = new Counter({
    name: 'rfqm_signed_quote_not_found',
    labelNames: ['chain_id'],
    help: 'A submitted quote did not match any stored quotes',
});
const RFQM_SIGNED_QUOTE_EXPIRY_TOO_SOON = new Counter({
    name: 'rfqm_signed_quote_expiry_too_soon',
    labelNames: ['chain_id'],
    help: 'A signed quote was not queued because it would expire too soon',
});
const RFQM_TAKER_AND_TAKERTOKEN_TRADE_EXISTS = new Counter({
    name: 'rfqm_signed_quote_taker_and_takertoken_trade_exists',
    labelNames: ['chain_id'],
    help: 'A trade was submitted when the system already had a pending trade for the same taker and takertoken',
});
const RFQM_SUBMIT_BALANCE_CHECK_FAILED = new Counter({
    name: 'rfqm_submit_balance_check_failed',
    labelNames: ['makerAddress', 'chain_id'],
    help: 'A trade was submitted but our on-chain balance check failed',
});
const RFQM_JOB_FAILED_MM_SIGNATURE_FAILED = new Counter({
    name: 'rfqm_job_failed_mm_signature_failed',
    help: 'A job failed because the market maker signature process failed. NOT triggered when the MM declines to sign.',
    labelNames: ['makerUri', 'chain_id'],
});
const RFQM_JOB_MM_REJECTED_LAST_LOOK = new Counter({
    name: 'rfqm_job_mm_rejected_last_look',
    help: 'A job rejected by market maker on last look',
    labelNames: ['makerUri', 'chain_id'],
});

const RFQM_PROCESS_JOB_LATENCY = new Summary({
    name: 'rfqm_process_job_latency',
    labelNames: ['chain_id'],
    help: 'Latency for the worker processing the job',
});

const RFQM_MINING_LATENCY = new Summary({
    name: 'rfqm_mining_latency',
    labelNames: ['chain_id'],
    help: 'The time in seconds between when the first transaction for a job is sent and when a transaction for the job is mined',
});

const RFQM_JOB_COMPLETED = new Counter({
    name: 'rfqm_job_completed',
    help: 'An Rfqm Job completed with no errors',
    labelNames: ['address', 'chain_id'],
});

const RFQM_JOB_COMPLETED_WITH_ERROR = new Counter({
    name: 'rfqm_job_completed_with_error',
    help: 'An Rfqm Job completed with an error',
    labelNames: ['address', 'chain_id'],
});

const PRICE_DECIMAL_PLACES = 6;

const MAX_PRIORITY_FEE_PER_GAS_CAP = new BigNumber(128e9); // The maximum tip we're willing to pay
// Retrying an EIP 1559 transaction: https://docs.alchemy.com/alchemy/guides/eip-1559/retry-eip-1559-tx
const MAX_PRIORITY_FEE_PER_GAS_MULTIPLIER = 1.5; // Increase multiplier for tip with each resubmission cycle
const MAX_FEE_PER_GAS_MULTIPLIER = 1.1; // Increase multiplier in max fee per gas with each cycle; limitation of geth node
// During recovery, we may not be able to successfully execute
// `estimateGasForExchangeProxyCallAsync`. In this case we use this value.
const MAX_GAS_ESTIMATE = 500_000;

// How often the worker should publish a heartbeat
const WORKER_HEARTBEAT_FREQUENCY_MS = ONE_SECOND_MS * 30; // tslint:disable-line: custom-no-magic-numbers

// https://stackoverflow.com/questions/47632622/typescript-and-filter-boolean
function isDefined<T>(value: T): value is NonNullable<T> {
    return value !== null && value !== undefined;
}

const getTokenAddressFromSymbol = (symbol: string, chainId: number): string => {
    return (getTokenMetadataIfExists(symbol, chainId) as TokenMetadata).tokenAddress;
};

/**
 * RfqmService is the coordination layer for HTTP based RFQM flows.
 */
export class RfqmService {
    private readonly _tokenDecimalsCache: Map<string, number> = new Map();
    private readonly _nativeTokenAddress: string;
    private readonly _nativeTokenSymbol: string;
    private readonly _nativeWrappedTokenSymbol: string;
    private readonly _nativeWrappedTokenAddress: string;
    private _lastHeartbeatTime: Date | null = null;

    public static shouldResubmitTransaction(gasFees: GasFees, gasPriceEstimate: BigNumber): boolean {
        // Geth only allows replacement of transactions if the replacement gas price
        // is at least 10% higher than the gas price of the transaction being replaced
        return gasPriceEstimate.gte(gasFees.maxFeePerGas.multipliedBy(MIN_GAS_PRICE_INCREASE + 1));
    }

    // Returns a failure status for invalid jobs and null if the job is valid.
    public static validateJob(job: RfqmV2JobEntity, now: Date = new Date()): RfqmJobStatus | null {
        const { makerUri, order, fee } = job;

        if (makerUri === undefined) {
            return RfqmJobStatus.FailedValidationNoMakerUri;
        }

        if (order === null) {
            return RfqmJobStatus.FailedValidationNoOrder;
        }

        if (fee === null) {
            return RfqmJobStatus.FailedValidationNoFee;
        }

        // Orders can expire if any of the following happen:
        // 1) workers are backed up
        // 2) an RFQM order broke during submission and the order is stuck in the queue for a long time.
        const otcOrderStringFields = job.order.order;
        const { expiry } = OtcOrder.parseExpiryAndNonce(new BigNumber(otcOrderStringFields.expiryAndNonce));
        const expiryTimeMs = expiry.times(ONE_SECOND_MS);
        if (expiryTimeMs.isNaN() || expiryTimeMs.lte(now.getTime())) {
            return RfqmJobStatus.FailedExpired;
        }
        if (!job.takerSignature) {
            return RfqmJobStatus.FailedValidationNoTakerSignature;
        }

        return null;
    }

    private static _getSellAmountGivenBuyAmountAndQuote(
        buyAmount: BigNumber,
        quotedTakerAmount: BigNumber,
        quotedMakerAmount: BigNumber,
    ): BigNumber {
        // Solving for x given the following proportion:
        // x / buyAmount = quotedTakerAmount / quotedMakerAmount
        return quotedTakerAmount.div(quotedMakerAmount).times(buyAmount).decimalPlaces(0);
    }

    private static _getBuyAmountGivenSellAmountAndQuote(
        sellAmount: BigNumber,
        quotedTakerAmount: BigNumber,
        quotedMakerAmount: BigNumber,
    ): BigNumber {
        // Solving for y given the following proportion:
        // y / sellAmount =  quotedMakerAmount / quotedTakerAmount
        return quotedMakerAmount.div(quotedTakerAmount).times(sellAmount).decimalPlaces(0);
    }

    constructor(
        private readonly _chainId: number,
        private readonly _rfqmFeeService: RfqmFeeService,
        private readonly _contractAddresses: AssetSwapperContractAddresses,
        private readonly _registryAddress: string,
        private readonly _blockchainUtils: RfqBlockchainUtils,
        private readonly _dbUtils: RfqmDbUtils,
        private readonly _sqsProducer: Producer,
        private readonly _quoteServerClient: QuoteServerClient,
        private readonly _transactionWatcherSleepTimeMs: number,
        private readonly _cacheClient: CacheClient,
        private readonly _rfqMakerManager: RfqMakerManager,
        private readonly _initialMaxPriorityFeePerGasGwei: number,
        private readonly _configManger: ConfigManager,
        private readonly _kafkaProducer?: KafkaProducer,
        private readonly _quoteReportTopic?: string,
    ) {
        this._nativeTokenSymbol = nativeTokenSymbol(this._chainId);
        this._nativeTokenAddress = getTokenAddressFromSymbol(this._nativeTokenSymbol, this._chainId);
        this._nativeWrappedTokenSymbol = nativeWrappedTokenSymbol(this._chainId);
        this._nativeWrappedTokenAddress = getTokenAddressFromSymbol(this._nativeWrappedTokenSymbol, this._chainId);
    }

    /**
     * Utility function to get the decimals for an ERC20 token by its address.
     * First checks 0x/token-metadata for the information, and if not present,
     * queries the data from the blockchain.
     *
     * Uses an in-memory cache to store previously-fetched values.
     *
     * Throws if there is a problem fetching the data from on chain.
     */
    public async getTokenDecimalsAsync(tokenAddress: string): Promise<number> {
        const localMetadata = getTokenMetadataIfExists(tokenAddress, this._chainId);
        if (localMetadata) {
            return localMetadata.decimals;
        }
        const cachedDecimals = this._tokenDecimalsCache.get(tokenAddress);
        if (cachedDecimals) {
            return cachedDecimals;
        }
        const onchainDecimals = await this._blockchainUtils.getTokenDecimalsAsync(tokenAddress);
        logger.info(
            { tokenAddress, decimals: onchainDecimals, cacheSize: this._tokenDecimalsCache.size },
            'Token decimals fetched from blockchain',
        );
        this._tokenDecimalsCache.set(tokenAddress, onchainDecimals);
        return onchainDecimals;
    }

    /**
     * Fetch the best indicative quote available. Returns null if no valid quotes found
     */
    public async fetchIndicativeQuoteAsync(
        params: FetchIndicativeQuoteParams,
    ): Promise<FetchIndicativeQuoteResponse | null> {
        const {
            sellAmount,
            buyAmount,
            sellToken: takerToken,
            buyToken: originalMakerToken,
            sellTokenDecimals: takerTokenDecimals,
            buyTokenDecimals: makerTokenDecimals,
        } = params;
        let makerToken = originalMakerToken;

        // If the originalMakerToken is the native token, we will trade the wrapped version and unwrap at the end
        const isUnwrap = originalMakerToken === this._nativeTokenAddress;
        if (isUnwrap) {
            makerToken = this._nativeWrappedTokenAddress;
            params.buyToken = this._nativeWrappedTokenAddress;
        }

        // Get desired fill amount
        const isSelling = sellAmount !== undefined;
        const assetFillAmount = isSelling ? sellAmount! : buyAmount!;

        // Get the fee and gas price
        const feeModelVersion = this._configManger.getFeeModelVersion();
        let feeWithDetails;
        switch (feeModelVersion) {
            case 1:
                feeWithDetails = await this._rfqmFeeService.calculateFeeV1Async(
                    makerToken,
                    takerToken,
                    makerTokenDecimals,
                    takerTokenDecimals,
                    isUnwrap,
                    isSelling,
                    assetFillAmount,
                );
                break;
            case 0:
            default:
                feeWithDetails = await this._rfqmFeeService.calculateGasFeeAsync(
                    makerToken,
                    takerToken,
                    isUnwrap,
                    feeModelVersion,
                );
        }

        // Fetch all indicative quotes
        const indicativeQuotes = await this._fetchIndicativeQuotesAsync(params, feeWithDetails);

        // Log any quotes that are for the incorrect amount
        indicativeQuotes.forEach((quote) => {
            const quotedAmount = isSelling ? quote.takerAmount : quote.makerAmount;
            if (quotedAmount.eq(assetFillAmount)) {
                return;
            }
            logger.warn(
                {
                    isSelling,
                    overOrUnder: quotedAmount.gt(assetFillAmount) ? 'overfill' : 'underfill',
                    requestedAmount: assetFillAmount,
                    quotedAmount,
                    quote,
                },
                'Maker returned an incorrect amount',
            );
        });

        // Get the best quote
        const bestQuote = getBestQuote(
            indicativeQuotes,
            isSelling,
            takerToken,
            makerToken,
            assetFillAmount,
            RFQM_MINIMUM_EXPIRY_DURATION_MS,
        );

        // Quote Report
        if (this._kafkaProducer) {
            await quoteReportUtils.publishRFQMQuoteReportAsync(
                {
                    taker: params.takerAddress,
                    buyTokenAddress: originalMakerToken,
                    sellTokenAddress: takerToken,
                    buyAmount: params.buyAmount,
                    sellAmount: params.sellAmount,
                    integratorId: params.integrator?.integratorId,
                    allQuotes: indicativeQuotes,
                    bestQuote,
                    fee: feeToStoredFee(feeWithDetails),
                },
                this._kafkaProducer,
                this._quoteReportTopic,
            );
        }

        // No quotes found
        if (bestQuote === null) {
            return null;
        }

        // Prepare the price
        const makerAmountInUnit = Web3Wrapper.toUnitAmount(bestQuote.makerAmount, makerTokenDecimals);
        const takerAmountInUnit = Web3Wrapper.toUnitAmount(bestQuote.takerAmount, takerTokenDecimals);
        const price = isSelling ? makerAmountInUnit.div(takerAmountInUnit) : takerAmountInUnit.div(makerAmountInUnit);
        // The way the BigNumber round down behavior (https://mikemcl.github.io/bignumber.js/#dp) works requires us
        // to add 1 to PRICE_DECIMAL_PLACES in order to actually come out with the decimal places specified.
        const roundedPrice = price.decimalPlaces(PRICE_DECIMAL_PLACES + 1, BigNumber.ROUND_DOWN);

        // Prepare response
        return {
            price: roundedPrice,
            gas: feeWithDetails.details.gasPrice,
            buyAmount: bestQuote.makerAmount,
            buyTokenAddress: originalMakerToken,
            sellAmount: bestQuote.takerAmount,
            sellTokenAddress: bestQuote.takerToken,
            allowanceTarget: this._contractAddresses.exchangeProxy,
        };
    }

    /**
     * Fetch the best firm quote available, including a metatransaction. Returns null if no valid quotes found
     */
    public async fetchFirmQuoteAsync(params: FetchFirmQuoteParams): Promise<OtcOrderRfqmQuoteResponse | null> {
        // Extract params
        const {
            sellAmount,
            buyAmount,
            sellToken: takerToken,
            buyToken: originalMakerToken,
            sellTokenDecimals: takerTokenDecimals,
            buyTokenDecimals: makerTokenDecimals,
            integrator,
            affiliateAddress,
        } = params;
        let makerToken = originalMakerToken;

        // If the originalMakerToken is the native token, we will trade the wrapped version and unwrap at the end
        const isUnwrap = originalMakerToken === this._nativeTokenAddress;
        if (isUnwrap) {
            makerToken = this._nativeWrappedTokenAddress;
            params.buyToken = this._nativeWrappedTokenAddress;
        }

        // Quote Requestor specific params
        const isSelling = sellAmount !== undefined;
        const assetFillAmount = isSelling ? sellAmount! : buyAmount!;

        // Get the fee and gas price
        const feeModelVersion = this._configManger.getFeeModelVersion();
        let feeWithDetails;
        switch (feeModelVersion) {
            case 1:
                feeWithDetails = await this._rfqmFeeService.calculateFeeV1Async(
                    makerToken,
                    takerToken,
                    makerTokenDecimals,
                    takerTokenDecimals,
                    isUnwrap,
                    isSelling,
                    assetFillAmount,
                );
                break;
            case 0:
            default:
                feeWithDetails = await this._rfqmFeeService.calculateGasFeeAsync(
                    makerToken,
                    takerToken,
                    isUnwrap,
                    feeModelVersion,
                );
        }
        const storedFeeWithDetails = feeToStoredFee(feeWithDetails);

        // Fetch all firm quotes and fee
        const firmQuotes = await this._fetchFirmQuotesAsync(params, feeWithDetails);

        // Get the best quote
        const bestQuote = getBestQuote(
            firmQuotes,
            isSelling,
            takerToken,
            makerToken,
            assetFillAmount,
            RFQM_MINIMUM_EXPIRY_DURATION_MS,
        );

        // Quote Report
        if (this._kafkaProducer) {
            await quoteReportUtils.publishRFQMQuoteReportAsync(
                {
                    taker: params.takerAddress,
                    buyTokenAddress: originalMakerToken,
                    sellTokenAddress: takerToken,
                    buyAmount: params.buyAmount,
                    sellAmount: params.sellAmount,
                    integratorId: params.integrator?.integratorId,
                    allQuotes: firmQuotes,
                    bestQuote,
                    fee: storedFeeWithDetails,
                },
                this._kafkaProducer,
            );
        }

        // No quote found
        if (bestQuote === null) {
            return null;
        }

        // Get the makerUri
        const makerUri = bestQuote.makerUri;
        if (makerUri === undefined) {
            logger.error({ makerAddress: bestQuote.order.maker }, 'makerUri unknown for maker address');
            throw new Error(`makerUri unknown for maker address ${bestQuote.order.maker}`);
        }

        // Prepare the price
        const makerAmountInUnit = Web3Wrapper.toUnitAmount(bestQuote.order.makerAmount, makerTokenDecimals);
        const takerAmountInUnit = Web3Wrapper.toUnitAmount(bestQuote.order.takerAmount, takerTokenDecimals);
        const price = isSelling ? makerAmountInUnit.div(takerAmountInUnit) : takerAmountInUnit.div(makerAmountInUnit);
        // The way the BigNumber round down behavior (https://mikemcl.github.io/bignumber.js/#dp) works requires us
        // to add 1 to PRICE_DECIMAL_PLACES in order to actually come out with the decimal places specified.
        const roundedPrice = price.decimalPlaces(PRICE_DECIMAL_PLACES + 1, BigNumber.ROUND_DOWN);

        // Prepare the final takerAmount and makerAmount
        const takerAmount = isSelling
            ? sellAmount!
            : RfqmService._getSellAmountGivenBuyAmountAndQuote(
                  buyAmount!,
                  bestQuote.order.takerAmount,
                  bestQuote.order.makerAmount,
              );

        const makerAmount = isSelling
            ? RfqmService._getBuyAmountGivenSellAmountAndQuote(
                  sellAmount!,
                  bestQuote.order.takerAmount,
                  bestQuote.order.makerAmount,
              )
            : buyAmount!;

        // Get the Order and its hash
        const orderHash = bestQuote.order.getHash();

        const otcOrder = bestQuote.order;
        await this._dbUtils.writeV2QuoteAsync({
            orderHash,
            chainId: this._chainId,
            fee: storedFeeWithDetails,
            order: otcOrderToStoredOtcOrder(otcOrder),
            makerUri,
            affiliateAddress,
            integratorId: integrator.integratorId,
            isUnwrap,
        });
        RFQM_QUOTE_INSERTED.labels(integrator.integratorId, integrator.integratorId, makerUri).inc();
        return {
            type: RfqmTypes.OtcOrder,
            price: roundedPrice,
            gas: feeWithDetails.details.gasPrice,
            buyAmount: makerAmount,
            buyTokenAddress: originalMakerToken,
            sellAmount: takerAmount,
            sellTokenAddress: bestQuote.order.takerToken,
            allowanceTarget: this._contractAddresses.exchangeProxy,
            order: bestQuote.order,
            orderHash,
        };
    }

    public async workerBeforeLogicAsync(workerAddress: string): Promise<boolean> {
        let gasPrice;
        try {
            gasPrice = await this._rfqmFeeService.getGasPriceEstimationAsync();
        } catch (error) {
            logger.error(
                { errorMessage: error.message },
                'Current gas price is unable to be fetched, marking worker as not ready.',
            );
            RFQM_WORKER_NOT_READY.labels(workerAddress, this._chainId.toString()).inc();
            return false;
        }

        const balance = await this._blockchainUtils.getAccountBalanceAsync(workerAddress);
        const balanceUnitAmount = Web3Wrapper.toUnitAmount(balance, ETH_DECIMALS).decimalPlaces(PRICE_DECIMAL_PLACES);
        RFQM_WORKER_BALANCE.labels(workerAddress, this._chainId.toString()).set(balanceUnitAmount.toNumber());

        // check for outstanding jobs from the worker and resolve them
        const unresolvedJobOrderHashes = await this._dbUtils
            .findV2UnresolvedJobsAsync(workerAddress, this._chainId)
            .then((x) => x.flat().map((j) => j.orderHash));

        RFQM_JOB_REPAIR.labels(workerAddress, this._chainId.toString()).inc(unresolvedJobOrderHashes.length);
        for (const orderHash of unresolvedJobOrderHashes) {
            logger.info({ workerAddress, orderHash }, `Unresolved job found, attempting to reprocess`);
            await this.processJobAsync(orderHash, workerAddress);
        }

        const isWorkerReady = await this._blockchainUtils.isWorkerReadyAsync(workerAddress, balance, gasPrice);
        if (!isWorkerReady) {
            RFQM_WORKER_NOT_READY.labels(workerAddress, this._chainId.toString()).inc();
            return false;
        }

        if (this._lastHeartbeatTime && Date.now() - this._lastHeartbeatTime.getTime() < WORKER_HEARTBEAT_FREQUENCY_MS) {
            return true;
        }

        // Publish a heartbeat if the worker is ready to go
        try {
            if (RFQM_WORKER_INDEX === undefined) {
                throw new Error('Worker index is undefined');
            }
            // NOTE: when merging with `feature/multichain`, update this line with
            // `const chainId = this._chain.chainId.
            const chainId = this._chainId;
            await this._dbUtils.upsertRfqmWorkerHeartbeatToDbAsync(workerAddress, RFQM_WORKER_INDEX, balance, chainId);
            this._lastHeartbeatTime = new Date();
        } catch (error) {
            logger.error(
                { workerAddress, balance, errorMessage: error.message },
                'Worker failed to write a heartbeat to storage',
            );
        }

        RFQM_WORKER_READY.labels(workerAddress, this._chainId.toString()).inc();
        return true;
    }

    public async getOrderStatusAsync(orderHash: string): Promise<StatusResponse | null> {
        const transformSubmission = (submission: RfqmV2TransactionSubmissionEntity) => {
            const { transactionHash: hash, createdAt } = submission;
            return hash ? { hash, timestamp: createdAt.getTime() } : null;
        };

        const transformSubmissions = (submissions: RfqmV2TransactionSubmissionEntity[]) =>
            submissions.map(transformSubmission).flatMap((s) => (s ? s : []));

        const job = await this._dbUtils.findV2JobByOrderHashAsync(orderHash);

        if (!job) {
            return null;
        }

        const { status, expiry } = job;

        if (status === RfqmJobStatus.PendingEnqueued && expiry.multipliedBy(ONE_SECOND_MS).lt(Date.now())) {
            // the workers are dead/on vacation and the expiration time has passed
            return {
                status: 'failed',
                transactions: [],
            };
        }

        const transactionSubmissions = await this._dbUtils.findV2TransactionSubmissionsByOrderHashAsync(orderHash);

        switch (status) {
            case RfqmJobStatus.PendingEnqueued:
            case RfqmJobStatus.PendingProcessing:
            case RfqmJobStatus.PendingLastLookAccepted:
                return { status: 'pending', transactions: [] };
            case RfqmJobStatus.PendingSubmitted:
                return {
                    status: 'submitted',
                    transactions: transformSubmissions(transactionSubmissions),
                };
            case RfqmJobStatus.FailedEthCallFailed:
            case RfqmJobStatus.FailedExpired:
            case RfqmJobStatus.FailedLastLookDeclined:
            case RfqmJobStatus.FailedPresignValidationFailed:
            case RfqmJobStatus.FailedRevertedConfirmed:
            case RfqmJobStatus.FailedRevertedUnconfirmed:
            case RfqmJobStatus.FailedSignFailed:
            case RfqmJobStatus.FailedSubmitFailed:
            case RfqmJobStatus.FailedValidationNoCallData:
            case RfqmJobStatus.FailedValidationNoFee:
            case RfqmJobStatus.FailedValidationNoMakerUri:
            case RfqmJobStatus.FailedValidationNoOrder:
            case RfqmJobStatus.FailedValidationNoTakerSignature:
                return {
                    status: 'failed',
                    transactions: transformSubmissions(transactionSubmissions),
                };
            case RfqmJobStatus.SucceededConfirmed:
            case RfqmJobStatus.SucceededUnconfirmed:
                const successfulTransactions = transactionSubmissions.filter(
                    (s) =>
                        s.status === RfqmTransactionSubmissionStatus.SucceededUnconfirmed ||
                        s.status === RfqmTransactionSubmissionStatus.SucceededConfirmed,
                );
                if (successfulTransactions.length !== 1) {
                    throw new Error(
                        `Expected exactly one successful transmission for order ${orderHash}; found ${successfulTransactions.length}`,
                    );
                }
                const successfulTransaction = successfulTransactions[0];
                const successfulTransactionData = transformSubmission(successfulTransaction);
                if (!successfulTransactionData) {
                    throw new Error(`Successful transaction did not have a hash`);
                }
                return {
                    status: status === RfqmJobStatus.SucceededUnconfirmed ? 'succeeded' : 'confirmed',
                    transactions: [successfulTransactionData],
                };
            default:
                ((_x: never): never => {
                    throw new Error('Unreachable');
                })(status);
        }
    }

    /**
     * Runs checks to determine the health of the RFQm system. The results may be distilled to a format needed by integrators.
     */
    public async runHealthCheckAsync(): Promise<HealthCheckResult> {
        const heartbeats = await this._dbUtils.findRfqmWorkerHeartbeatsAsync(this._chainId);
        let gasPrice: BigNumber | undefined;
        try {
            gasPrice = await this._rfqmFeeService.getGasPriceEstimationAsync();
        } catch (error) {
            logger.warn({ errorMessage: error.message }, 'Failed to get gas price for health check');
        }
        return computeHealthCheckAsync(
            RFQM_MAINTENANCE_MODE,
            this._rfqMakerManager.getRfqmMakerOfferings(),
            this._sqsProducer,
            heartbeats,
            this._chainId,
            gasPrice,
        );
    }

    /**
     * Validates and enqueues the Taker Signed Otc Order for submission
     */
    public async submitTakerSignedOtcOrderAsync(
        params: OtcOrderSubmitRfqmSignedQuoteParams,
    ): Promise<OtcOrderSubmitRfqmSignedQuoteResponse> {
        const { order } = params;
        let { signature: takerSignature } = params;
        const orderHash = params.order.getHash();
        const takerAddress = order.taker.toLowerCase();
        const makerAddress = order.maker.toLowerCase();
        const takerToken = order.takerToken.toLowerCase();
        const makerToken = order.makerToken.toLowerCase();
        // check that the orderHash is indeed a recognized quote
        const quote = await this._dbUtils.findV2QuoteByOrderHashAsync(orderHash);
        if (!quote) {
            RFQM_SIGNED_QUOTE_NOT_FOUND.inc();
            throw new NotFoundError('quote not found');
        }

        // validate that the expiration window is long enough to fill quote
        const currentTimeMs = new Date().getTime();
        if (!params.order.expiry.times(ONE_SECOND_MS).isGreaterThan(currentTimeMs + RFQM_MINIMUM_EXPIRY_DURATION_MS)) {
            RFQM_SIGNED_QUOTE_EXPIRY_TOO_SOON.labels(this._chainId.toString()).inc();
            throw new ValidationError([
                {
                    field: 'expiryAndNonce',
                    code: ValidationErrorCodes.FieldInvalid,
                    reason: `order will expire too soon`,
                },
            ]);
        }

        // validate that there is not a pending transaction for this taker and taker token
        const pendingJobs = await this._dbUtils.findV2JobsWithStatusesAsync([
            RfqmJobStatus.PendingEnqueued,
            RfqmJobStatus.PendingProcessing,
            RfqmJobStatus.PendingLastLookAccepted,
            RfqmJobStatus.PendingSubmitted,
        ]);

        if (
            pendingJobs.some(
                (job) =>
                    job.order?.order.taker.toLowerCase() === quote.order?.order.taker.toLowerCase() &&
                    job.order?.order.takerToken.toLowerCase() === quote.order?.order.takerToken.toLowerCase() &&
                    // Other logic handles the case where the same order is submitted twice
                    job.orderHash !== quote.orderHash,
            )
        ) {
            RFQM_TAKER_AND_TAKERTOKEN_TRADE_EXISTS.labels(this._chainId.toString()).inc();
            throw new TooManyRequestsError('a pending trade for this taker and takertoken already exists');
        }

        // In the unlikely event that takers submit a signature with a missing byte, pad the signature.
        const paddedSignature = padSignature(takerSignature);
        if (paddedSignature.r !== takerSignature.r || paddedSignature.s !== takerSignature.s) {
            logger.warn(
                { orderHash, r: paddedSignature.r, s: paddedSignature.s },
                'Got taker signature with missing bytes',
            );
            takerSignature = paddedSignature;
        }

        // validate that the given taker signature is valid
        const signerAddress = getSignerFromHash(orderHash, takerSignature).toLowerCase();
        if (signerAddress !== takerAddress) {
            logger.warn({ signerAddress, takerAddress, orderHash }, 'Signature is invalid');
            throw new ValidationError([
                {
                    field: 'signature',
                    code: ValidationErrorCodes.InvalidSignatureOrHash,
                    reason: `signature is not valid`,
                },
            ]);
        }

        // validate that order is fillable by both the maker and the taker according to balances and allowances
        const [makerBalance, takerBalance] = await this._blockchainUtils.getTokenBalancesAsync(
            [makerAddress, takerAddress],
            [makerToken, takerToken],
        );
        if (makerBalance.lt(order.makerAmount) || takerBalance.lt(order.takerAmount)) {
            RFQM_SUBMIT_BALANCE_CHECK_FAILED.labels(makerAddress, this._chainId.toString()).inc();
            logger.warn(
                {
                    makerBalance,
                    takerBalance,
                    makerAddress,
                    takerAddress,
                    orderHash,
                    order,
                },
                'Balance check failed while user was submitting',
            );
            throw new ValidationError([
                {
                    field: 'n/a',
                    code: ValidationErrorCodes.InvalidOrder,
                    reason: `order is not fillable`,
                },
            ]);
        }

        // prepare the job
        const rfqmJobOpts: RfqmV2JobConstructorOpts = {
            orderHash: quote.orderHash!,
            createdAt: new Date(),
            expiry: order.expiry,
            chainId: this._chainId,
            integratorId: quote.integratorId ? quote.integratorId : null,
            makerUri: quote.makerUri,
            status: RfqmJobStatus.PendingEnqueued,
            fee: quote.fee,
            order: quote.order,
            takerSignature,
            affiliateAddress: quote.affiliateAddress,
            isUnwrap: quote.isUnwrap,
        };

        // this insert will fail if a job has already been created, ensuring
        // that a signed quote cannot be queued twice
        try {
            // make sure job data is persisted to Postgres before queueing task
            await this._dbUtils.writeV2JobAsync(rfqmJobOpts);
            await this._enqueueJobAsync(quote.orderHash!, RfqmTypes.OtcOrder);
        } catch (error) {
            logger.error({ errorMessage: error.message }, 'Failed to queue the quote for submission.');
            throw new InternalServerError(
                `failed to queue the quote for submission, it may have already been submitted`,
            );
        }

        return {
            type: RfqmTypes.OtcOrder,
            orderHash: quote.orderHash!,
        };
    }

    /**
     * Top-level logic the worker uses to take a v1 or v2 job to completion.
     * The orderHash can come from either an unfinished job found during the
     * worker before logic or from an SQS message, and it may be the hash for
     * either a v1 or v2 job.
     *
     * Big picture steps:
     * 1. Fetch the job from the database
     * 2. Prepare the job by validating it & conducting a last look (v1)
     *    or getting the market maker signature (v2).
     *    This step uses different functions for v1 and v2 jobs.
     * 3. Submit a transaction if none exist, wait for mining + confirmation,
     *    and submit new transactions if gas prices rise
     * 4. Finalize the job status
     *
     * This function is the error boundary for job processing; errors will be caught, logged
     * and swallowed. The worker will continue along its lifecycle.
     *
     * This function handles processing latency metrics & job success/fail counters.
     */
    public async processJobAsync(orderHash: string, workerAddress: string): Promise<void> {
        logger.info({ orderHash, workerAddress }, 'Start process job');
        const timerStopFunction = RFQM_PROCESS_JOB_LATENCY.labels(this._chainId.toString()).startTimer();

        try {
            // Step 1: Find the job via the order hash
            let job = await this._dbUtils.findV2JobByOrderHashAsync(orderHash);
            if (!job) {
                throw new Error('No job found for order hash');
            }

            // Step 2: Prepare the job for submission

            // Claim job for worker
            if (job.workerAddress!! && job.workerAddress !== workerAddress) {
                throw new Error('Worker was sent a job claimed by a different worker');
            }
            job.workerAddress = workerAddress;
            await this._dbUtils.updateRfqmJobAsync(job);

            let calldata: string;

            const prepareV2JobResult = await this.prepareV2JobAsync(job, workerAddress);
            job = prepareV2JobResult.job;
            calldata = prepareV2JobResult.calldata;
            // Step 3: Send to blockchain
            const finalStatus = await this.submitJobToChainAsync(job, workerAddress, calldata);

            // Step 4: Close out job
            job.status = finalStatus;
            await this._dbUtils.updateRfqmJobAsync(job);
            if (finalStatus === RfqmJobStatus.FailedExpired) {
                throw new Error('Job expired');
            }
            logger.info({ orderHash, workerAddress }, 'Job completed without errors');
            RFQM_JOB_COMPLETED.labels(workerAddress, this._chainId.toString()).inc();
        } catch (error) {
            logger.error({ workerAddress, orderHash, errorMessage: error.message }, 'Job completed with error');
            RFQM_JOB_COMPLETED_WITH_ERROR.labels(workerAddress, this._chainId.toString()).inc();
        } finally {
            timerStopFunction();
        }
    }

    /**
     * Prepares an RfqmV2 Job for submission by validatidating the job, obtaining the
     * market maker signature, and constructing the calldata.
     *
     * Handles reties of retryable errors. Throws for unretriable errors, and logs
     * ONLY IF the log needs more information than the orderHash and workerAddress,
     * which are logged by the `processJobAsync` routine.
     * Updates job in database.
     *
     * @returns The job, ready for transaction submission, and the calldata
     * @throws If the job cannot be submitted (e.g. it is expired)
     */
    public async prepareV2JobAsync(
        job: RfqmV2JobEntity,
        workerAddress: string,
        now: Date = new Date(),
    ): Promise<{ calldata: string; job: RfqmV2JobEntity }> {
        const _job = _.cloneDeep(job);
        const { makerUri, order, orderHash } = _job;
        const otcOrder = storedOtcOrderToOtcOrder(order);
        let makerSignature: Signature | null = _job.makerSignature;
        const takerSignature: Signature | null = _job.takerSignature;

        // Check to see if we have already submitted a transaction for this job.
        // If we have, the job is already prepared and we can skip ahead.
        const transactionSubmissions = await this._dbUtils.findV2TransactionSubmissionsByOrderHashAsync(_job.orderHash);
        if (transactionSubmissions.length) {
            if (!makerSignature) {
                // This shouldn't happen
                throw new Error('Encountered a job with submissions but no maker signature');
            }
            if (!takerSignature) {
                // This shouldn't happen
                throw new Error('Encountered a job with submissions but no taker signature');
            }
            const existingSubmissionCalldata = this._blockchainUtils.generateTakerSignedOtcOrderCallData(
                otcOrder,
                makerSignature,
                takerSignature,
                _job.isUnwrap,
                _job.affiliateAddress,
            );
            return { calldata: existingSubmissionCalldata, job: _job };
        }

        const errorStatus = RfqmService.validateJob(_job, now);
        if (errorStatus !== null) {
            _job.status = errorStatus;
            await this._dbUtils.updateRfqmJobAsync(_job);

            if (errorStatus === RfqmJobStatus.FailedExpired) {
                RFQM_SIGNED_QUOTE_EXPIRY_TOO_SOON.labels(this._chainId.toString()).inc();
            }
            logger.error({ orderHash, errorStatus }, 'Job failed validation');
            throw new Error('Job failed validation');
        }

        // Existence of taker signature has already been checked by
        // `RfqmService.validateJob(job)`. Refine the type.
        if (!takerSignature) {
            throw new Error('No taker signature present');
        }

        if (_job.status === RfqmJobStatus.PendingEnqueued) {
            _job.status = RfqmJobStatus.PendingProcessing;
            await this._dbUtils.updateRfqmJobAsync(_job);
        }

        if (_job.makerSignature) {
            // Market Maker had already signed order
            logger.info({ workerAddress, orderHash }, 'Order already signed');
        } else {
            // validate that order is fillable by both the maker and the taker according to balances and allowances
            const [makerBalance, takerBalance] = await this._blockchainUtils.getTokenBalancesAsync(
                [otcOrder.maker, otcOrder.taker],
                [otcOrder.makerToken, otcOrder.takerToken],
            );
            if (makerBalance.lt(otcOrder.makerAmount) || takerBalance.lt(otcOrder.takerAmount)) {
                logger.error(
                    {
                        orderHash,
                        makerBalance,
                        takerBalance,
                        makerAmount: otcOrder.makerAmount,
                        takerAmount: otcOrder.takerAmount,
                    },
                    'Order failed pre-sign validation',
                );
                _job.status = RfqmJobStatus.FailedPresignValidationFailed;
                await this._dbUtils.updateRfqmJobAsync(_job);
                throw new Error('Order failed pre-sign validation');
            }

            const signRequest: SignRequest = {
                expiry: _job.expiry,
                fee: storedFeeToFee(_job.fee),
                order: otcOrder,
                orderHash,
                takerSignature,
            };

            // "Last Look" in v1 is replaced by market maker order signing in v2.
            const signAttemptTimeMs = Date.now();
            try {
                makerSignature = await retry(
                    async () =>
                        this._quoteServerClient
                            .signV2Async(makerUri, _job.integratorId ?? '', signRequest)
                            .then((s) => s ?? null),
                    {
                        delay: ONE_SECOND_MS,
                        factor: 2,
                        maxAttempts: 3,
                        handleError: (error, context, _options) => {
                            const { attemptNum: attemptNumber, attemptsRemaining } = context;
                            logger.warn(
                                { orderHash, makerUri, attemptNumber, attemptsRemaining, error: error.message },
                                'Error encountered while attempting to get market maker signature',
                            );
                        },
                    },
                );
            } catch (error) {
                // The sign process has failed after retries
                RFQM_JOB_FAILED_MM_SIGNATURE_FAILED.labels(makerUri, this._chainId.toString()).inc();
                logger.error(
                    { orderHash, makerUri, error: error.message },
                    'RFQM v2 job failed due to market maker sign failure',
                );
                _job.status = RfqmJobStatus.FailedSignFailed;
                await this._dbUtils.updateRfqmJobAsync(_job);
                throw new Error('Job failed during market maker sign attempt');
            }

            logger.info({ makerUri, signed: !!makerSignature, orderHash }, 'Got signature response from market maker');

            if (!makerSignature) {
                // Market Maker has declined to sign the transaction
                RFQM_JOB_MM_REJECTED_LAST_LOOK.labels(makerUri, this._chainId.toString()).inc();
                _job.lastLookResult = false;
                _job.status = RfqmJobStatus.FailedLastLookDeclined;
                await this._dbUtils.updateRfqmJobAsync(_job);

                // We'd like some data on how much the price the market maker is offering
                // has changed. We query the market maker's price endpoint with the same
                // trade they've just declined to sign and log the result.
                try {
                    const declineToSignPriceCheckTimeMs = Date.now();
                    const otcOrderParams = QuoteServerClient.makeQueryParameters({
                        chainId: this._chainId,
                        txOrigin: this._registryAddress,
                        takerAddress: otcOrder.taker,
                        marketOperation: MarketOperation.Sell,
                        buyTokenAddress: otcOrder.makerToken,
                        sellTokenAddress: otcOrder.takerToken,
                        assetFillAmount: otcOrder.takerAmount,
                        isLastLook: true,
                        fee: storedFeeToFee(job.fee),
                    });
                    // Instead of adding a dependency to `ConfigManager` to get the actual integrator
                    // (we only have the ID at this point), just create a stand-in.
                    // This will send the same integrator ID to the market maker; they will not be
                    // able to tell the difference.
                    // `logRfqMakerNetworkInteraction` does use the `label`, however, but I think the
                    // tradeoff is reasonable.
                    const integrator: Integrator = {
                        apiKeys: [],
                        integratorId: job.integratorId!,
                        allowedChainIds: [this._chainId],
                        label: 'decline-to-sign-price-check',
                        plp: true,
                        rfqm: true,
                        rfqt: true,
                    };
                    const priceResponse = await this._quoteServerClient.getPriceV2Async(
                        job.makerUri,
                        integrator,
                        otcOrderParams,
                    );
                    if (!priceResponse) {
                        throw new Error('Failed to get a price response');
                    }
                    const { makerAmount: priceCheckMakerAmount, takerAmount: priceCheckTakerAmount } = priceResponse;
                    const originalPrice = otcOrder.makerAmount.dividedBy(priceCheckTakerAmount);
                    const priceAfterReject = priceCheckMakerAmount.dividedBy(priceCheckTakerAmount);
                    const bipsFactor = 10000;
                    const priceDifferenceBips = originalPrice
                        .minus(priceAfterReject)
                        .dividedBy(originalPrice)
                        .absoluteValue()
                        .times(bipsFactor)
                        .toPrecision(1);
                    // The time, in seconds, between when we initiated the sign attempt and when we
                    // initiated the price check after the maker declined to sign.
                    const priceCheckDelayS = (declineToSignPriceCheckTimeMs - signAttemptTimeMs) / ONE_SECOND_MS;
                    logger.info(
                        {
                            orderHash,
                            originalPrice: originalPrice.toNumber(),
                            priceAfterReject: priceAfterReject.toNumber(),
                            priceCheckDelayS,
                            priceDifferenceBips,
                        },
                        'Decline to sign price check',
                    );
                    try {
                        _job.llRejectPriceDifferenceBps = parseInt(priceDifferenceBips, 10);
                        await this._dbUtils.updateRfqmJobAsync(_job);
                    } catch (e) {
                        logger.warn({ orderHash, errorMessage: e.message }, 'Saving LL reject price difference failed');
                    }
                } catch (error) {
                    logger.warn(
                        { errorMessage: error.message },
                        'Encountered error during decline to sign price check',
                    );
                }
                throw new Error('Market Maker declined to sign');
            }

            // Certain market makers are returning signature components which are missing
            // leading bytes. Add them if they don't exist.
            const paddedSignature = padSignature(makerSignature);
            if (paddedSignature.r !== makerSignature.r || paddedSignature.s !== makerSignature.s) {
                logger.warn(
                    { orderHash, r: paddedSignature.r, s: paddedSignature.s },
                    'Got market maker signature with missing bytes',
                );
                makerSignature = paddedSignature;
            }

            _job.makerSignature = paddedSignature;
            _job.lastLookResult = true;
            _job.status = RfqmJobStatus.PendingLastLookAccepted;
            await this._dbUtils.updateRfqmJobAsync(_job);
        }

        // Maker signature must already be defined here -- refine the type
        if (!makerSignature) {
            throw new Error('Maker signature does not exist');
        }

        // Verify the signer was the maker
        const signerAddress = getSignerFromHash(orderHash, makerSignature!).toLowerCase();
        const makerAddress = order.order.maker.toLowerCase();
        if (signerAddress !== makerAddress) {
            logger.info({ signerAddress, makerAddress, orderHash, makerUri }, 'Possible use of smart contract wallet');
            const isValidSigner = await this._blockchainUtils.isValidOrderSignerAsync(makerAddress, signerAddress);
            if (!isValidSigner) {
                _job.status = RfqmJobStatus.FailedSignFailed;
                await this._dbUtils.updateRfqmJobAsync(_job);
                throw new Error('Invalid order signer address');
            }
        }

        // Generate the calldata
        const calldata = this._blockchainUtils.generateTakerSignedOtcOrderCallData(
            otcOrder,
            _job.makerSignature,
            takerSignature,
            _job.isUnwrap,
            _job.affiliateAddress,
        );

        // With the Market Maker signature, execute a full eth_call to validate the
        // transaction via `estimateGasForFillTakerSignedOtcOrderAsync`
        try {
            await retry(
                async () => {
                    // Maker signature must already be defined here -- refine the type
                    if (!makerSignature) {
                        throw new Error('Maker signature does not exist');
                    }
                    // Taker signature must already be defined here -- refine the type
                    if (!takerSignature) {
                        throw new Error('Taker signature does not exist');
                    }

                    return this._blockchainUtils.estimateGasForFillTakerSignedOtcOrderAsync(
                        otcOrder,
                        makerSignature,
                        takerSignature,
                        workerAddress,
                        _job.isUnwrap,
                    );
                },
                {
                    delay: ONE_SECOND_MS,
                    factor: 1,
                    maxAttempts: 3,
                    handleError: (error, context, _options) => {
                        const { attemptNum: attemptNumber, attemptsRemaining } = context;
                        logger.warn(
                            { orderHash, makerUri, attemptNumber, attemptsRemaining, error: error.message },
                            'Error during eth_call validation. Retrying.',
                        );
                    },
                },
            );
        } catch (error) {
            _job.status = RfqmJobStatus.FailedEthCallFailed;
            await this._dbUtils.updateRfqmJobAsync(_job);

            logger.error({ orderHash, error: error.message }, 'eth_call validation failed');

            // Attempt to gather extra context upon eth_call failure
            try {
                const [makerBalance, takerBalance] = await this._blockchainUtils.getTokenBalancesAsync(
                    [otcOrder.maker, otcOrder.taker],
                    [otcOrder.makerToken, otcOrder.takerToken],
                );
                const blockNumber = await this._blockchainUtils.getCurrentBlockAsync();
                logger.info(
                    {
                        makerBalance,
                        takerBalance,
                        calldata,
                        blockNumber,
                        orderHash,
                        order: otcOrder,
                        bucket: otcOrder.nonceBucket,
                        nonce: otcOrder.nonce,
                    },
                    'Extra context after eth_call validation failed',
                );
            } catch (error) {
                logger.warn({ orderHash }, 'Failed to get extra context after eth_call validation failed');
            }
            throw new Error('Eth call validation failed');
        }

        return { job: _job, calldata };
    }

    /**
     * Takes a prepared job and submits it to the blockchain.
     *
     * First checks to see if there are previous transactions and enters the
     * watch loop; if not, submits an initial transaction and enters the wotch loop.
     *
     * During the watch loop, waits for a transaction to be mined and confirmed;
     * replaces the transaction if gas prices rise while a transactions are in the mempool.
     *
     * TODO (MKR-130): If the expiration passes during the watch loop, submit a "bailout"
     * transaction and exit.
     */
    public async submitJobToChainAsync(
        job: RfqmV2JobEntity,
        workerAddress: string,
        calldata: string,
        now: Date = new Date(),
    ): Promise<RfqmJobStatus.FailedRevertedConfirmed | RfqmJobStatus.FailedExpired | RfqmJobStatus.SucceededConfirmed> {
        const _job = _.cloneDeep(job);
        const { orderHash } = _job;
        const previousSubmissionsWithPresubmits = await this._dbUtils.findV2TransactionSubmissionsByOrderHashAsync(
            orderHash,
        );

        const previousSubmissions = await this._recoverPresubmitTransactionsAsync(previousSubmissionsWithPresubmits);

        const gasPriceEstimate = await this._rfqmFeeService.getGasPriceEstimationAsync();

        // For the first submission, we use the "fast" gas estimate to approximate the base fee.
        // We use the strategy outlined in https://www.blocknative.com/blog/eip-1559-fees --
        // The `maxFeePerGas` is 2x the base fee (plus priority tip). Since we don't have a
        // handy oracle for the en vogue priorty fee we start with 2 gwei and work up from there.

        const initialMaxPriorityFeePerGas = new BigNumber(this._initialMaxPriorityFeePerGasGwei).times(
            Math.pow(10, GWEI_DECIMALS),
        );

        let gasFees: GasFees = {
            maxFeePerGas: gasPriceEstimate.multipliedBy(2).plus(initialMaxPriorityFeePerGas),
            maxPriorityFeePerGas: initialMaxPriorityFeePerGas,
        };

        let submissionContext;
        let nonce;
        let gasEstimate;

        if (!previousSubmissions.length) {
            // There's an edge case here where there are previous submissions but they're all in `PRESUBMIT`.
            // Those are filtered out if they can't be found on the blockchain so we end up here.
            // If this occurs we need to check if the transaction is expired.
            const { expiry } = _job;
            const nowSeconds = new BigNumber(now.getTime() / ONE_SECOND_MS);

            if (expiry.isLessThan(nowSeconds)) {
                _job.status = RfqmJobStatus.FailedExpired;
                await this._dbUtils.updateRfqmJobAsync(_job);
                return RfqmJobStatus.FailedExpired;
            }

            logger.info({ orderHash, workerAddress }, 'Attempting to submit first transaction');

            _job.status = RfqmJobStatus.PendingSubmitted;
            await this._dbUtils.updateRfqmJobAsync(_job);

            logger.info(
                {
                    gasFees,
                    gasPriceEstimate,
                    orderHash,
                    submissionCount: 0,
                    workerAddress,
                },
                'Submitting transaction',
            );

            nonce = await this._blockchainUtils.getNonceAsync(workerAddress);
            gasEstimate = await this._blockchainUtils.estimateGasForExchangeProxyCallAsync(calldata, workerAddress);

            const firstSubmission = await this._submitTransactionAsync(
                orderHash,
                workerAddress,
                calldata,
                gasFees,
                nonce,
                gasEstimate,
            );

            logger.info(
                { workerAddress, orderHash, transactionHash: firstSubmission.transactionHash },
                'Successfully submitted transaction',
            );

            submissionContext = new SubmissionContext(this._blockchainUtils, [firstSubmission]);
        } else {
            logger.info({ workerAddress, orderHash }, `Previous submissions found, recovering context`);
            submissionContext = new SubmissionContext(this._blockchainUtils, previousSubmissions);
            nonce = submissionContext.nonce;

            // If we've already submitted a transaction and it has been mined,
            // using `_blockchainUtils.estimateGasForExchangeProxyCallAsync` will throw
            // given the same calldata. In the edge case where a transaction has been sent
            // but not mined, we would ideally pull the gas estimate from the previous
            // transaction. Unfortunately, we currently do not store it on the
            // `RfqmV2TransactionSubmissionEntity`. As a workaround, we'll just use an
            // overestimate..
            gasEstimate = MAX_GAS_ESTIMATE;
        }

        const expectedTakerTokenFillAmount = new BigNumber(_job.order.order.takerAmount);

        // The "Watch Loop"
        while (true) {
            // We've already submitted the transaction once at this point, so we first need to wait before checking the status.
            await delay(this._transactionWatcherSleepTimeMs);

            const jobStatus = await this._checkSubmissionMapReceiptsAndUpdateDbAsync(
                _job,
                submissionContext,
                expectedTakerTokenFillAmount,
            );

            switch (jobStatus) {
                case RfqmJobStatus.PendingSubmitted:
                    // We've put in at least one transaction but none have been mined yet.
                    // Check to make sure we haven't passed the expiry window.
                    const { expiry } = _job;
                    const nowSeconds = new BigNumber(new Date().getTime() / ONE_SECOND_MS);

                    const secondsPastExpiration = nowSeconds.minus(expiry);

                    // If we're more than 120 seconds past expiration, give up.
                    // See https://github.com/rolandkofler/blocktime for some
                    // analysis of expected block times. Two minutes was selected
                    // to cover most cases without locking up the worker for too long.
                    if (secondsPastExpiration.isGreaterThan(ONE_MINUTE_S * 2)) {
                        return RfqmJobStatus.FailedExpired;
                    }
                    // If we're past expiration by less than a minute, don't put in any new transactions
                    // but keep watching in case a receipt shows up
                    if (secondsPastExpiration.isGreaterThan(0)) {
                        continue;
                    }

                    // "Fast" gas price estimation; used to approximate the base fee
                    const newGasPriceEstimate = await this._rfqmFeeService.getGasPriceEstimationAsync();

                    if (submissionContext.transactionType === 0) {
                        throw new Error('Non-EIP-1559 transactions are not implemented');
                    }

                    // We don't wait for gas conditions to change. Rather, we increase the gas
                    // based bid based onthe knowledge that time (and therefore blocks, theoretically)
                    // has passed without a transaction being mined.

                    const { maxFeePerGas: oldMaxFeePerGas, maxPriorityFeePerGas: oldMaxPriorityFeePerGas } =
                        submissionContext.maxGasFees;

                    if (oldMaxFeePerGas.isGreaterThanOrEqualTo(MAX_PRIORITY_FEE_PER_GAS_CAP)) {
                        // If we've reached the max priority fee per gas we'd like to pay, just
                        // continue watching the transactions to see if one gets mined.
                        continue;
                    }

                    const newMaxPriorityFeePerGas = oldMaxPriorityFeePerGas.multipliedBy(
                        MAX_PRIORITY_FEE_PER_GAS_MULTIPLIER,
                    );

                    // The RPC nodes still need at least a 0.1 increase in both values to accept the new transaction.
                    // For the new max fee per gas, we'll take the maximum of a 0.1 increase from the last value
                    // or the value from an increase in the base fee.
                    const newMaxFeePerGas = BigNumber.max(
                        oldMaxFeePerGas.multipliedBy(MAX_FEE_PER_GAS_MULTIPLIER),
                        newGasPriceEstimate.multipliedBy(2).plus(newMaxPriorityFeePerGas),
                    );

                    gasFees = {
                        maxFeePerGas: newMaxFeePerGas,
                        maxPriorityFeePerGas: newMaxPriorityFeePerGas,
                    };

                    logger.info(
                        {
                            gasFees,
                            gasPriceEstimate,
                            orderHash,
                            submissionCount: submissionContext.transactions.length + 1,
                            workerAddress,
                        },
                        'Submitting transaction',
                    );

                    try {
                        const newTransaction = await this._submitTransactionAsync(
                            orderHash,
                            workerAddress,
                            calldata,
                            gasFees,
                            nonce,
                            gasEstimate,
                        );
                        logger.info(
                            { workerAddress, orderHash, transactionHash: newTransaction.transactionHash },
                            'Successfully resubmited tx with higher gas price',
                        );
                        submissionContext.addTransaction(newTransaction);
                    } catch (err) {
                        const errorMessage = err.message;
                        const isNonceTooLow = /nonce too low/.test(errorMessage);
                        logger.warn(
                            { workerAddress, orderHash, errorMessage: err.message, isNonceTooLow },
                            'Encountered an error re-submitting a tx',
                        );
                        if (isNonceTooLow) {
                            logger.info(
                                { workerAddress, orderHash },
                                'Ignore nonce too low error on re-submission. A previous submission was successful',
                            );
                            break;
                        }

                        // Rethrow on all other types of errors
                        throw err;
                    }
                    break;

                case RfqmJobStatus.FailedRevertedUnconfirmed:
                case RfqmJobStatus.SucceededUnconfirmed:
                    break;
                case RfqmJobStatus.FailedRevertedConfirmed:
                case RfqmJobStatus.SucceededConfirmed:
                    return jobStatus;
                default:
                    ((_x: never) => {
                        throw new Error('unreachable');
                    })(jobStatus);
            }
        }
    }

    /**
     * Internal method to fetch indicative quotes. Handles fetching both Rfq and Otc quotes
     */
    private async _fetchIndicativeQuotesAsync(
        params: FetchIndicativeQuoteParams,
        fee: Fee,
    ): Promise<IndicativeQuote[]> {
        // Extract params
        const { sellAmount, buyAmount, sellToken: takerToken, buyToken: makerToken, integrator } = params;

        // Quote Requestor specific params
        const isSelling = sellAmount !== undefined;
        const marketOperation = isSelling ? MarketOperation.Sell : MarketOperation.Buy;
        const assetFillAmount = isSelling ? sellAmount! : buyAmount!;

        // Create Otc Order request options
        const otcOrderParams = QuoteServerClient.makeQueryParameters({
            chainId: this._chainId,
            txOrigin: this._registryAddress,
            takerAddress: NULL_ADDRESS,
            marketOperation,
            buyTokenAddress: makerToken,
            sellTokenAddress: takerToken,
            assetFillAmount,
            isLastLook: true,
            fee,
        });
        const otcOrderMakerUris = this._rfqMakerManager.getRfqmMakerUrisForPairOnOtcOrder(makerToken, takerToken);

        const quotes = await this._quoteServerClient.batchGetPriceV2Async(
            otcOrderMakerUris,
            integrator,
            otcOrderParams,
        );

        return quotes;
    }

    /**
     * Internal method to fetch firm quotes. Handles fetching both Rfq and Otc quotes
     */
    private async _fetchFirmQuotesAsync(params: FetchFirmQuoteParams, fee: Fee): Promise<FirmOtcQuote[]> {
        const quotes = await this._fetchIndicativeQuotesAsync(params, fee);

        const currentBucket = (await this._cacheClient.getNextOtcOrderBucketAsync(this._chainId)) % RFQM_NUM_BUCKETS;
        const nowSeconds = Math.floor(Date.now() / ONE_SECOND_MS);
        const otcQuotes = quotes.map((q) =>
            this._mapIndicativeQuoteToFirmOtcQuote(
                q,
                params.takerAddress,
                new BigNumber(currentBucket),
                new BigNumber(nowSeconds),
            ),
        );

        const firmQuotesWithCorrectChainId = otcQuotes.filter((quote) => {
            if (quote.order.chainId !== this._chainId) {
                logger.error({ quote }, 'Received a quote with incorrect chain id');
                return false;
            }
            return true;
        });

        return firmQuotesWithCorrectChainId;
    }

    /**
     * Check for receipts from the tx hashes and update databases with status of all tx's.
     *
     * TODO (rhinodavid): Make this do less
     */
    private async _checkSubmissionMapReceiptsAndUpdateDbAsync(
        job: RfqmV2JobEntity,
        submissionContext: SubmissionContext,
        expectedTakerTokenFillAmount: BigNumber,
    ): Promise<
        | RfqmJobStatus.PendingSubmitted
        | RfqmJobStatus.FailedRevertedConfirmed
        | RfqmJobStatus.FailedRevertedUnconfirmed
        | RfqmJobStatus.SucceededConfirmed
        | RfqmJobStatus.SucceededUnconfirmed
    > {
        const _job = _.cloneDeep(job);
        // At most one tx can be mined, since they all have the same nonce.
        const minedReceipt = await submissionContext.getReceiptAsync();

        // If the tx hasn't been mined yet, there're no database updates to do.
        if (!minedReceipt) {
            return RfqmJobStatus.PendingSubmitted;
        }

        // Attempt to publish the mining latency
        try {
            const { timestamp: minedBlockTimestampS } = await this._blockchainUtils.getBlockAsync(
                minedReceipt.blockHash,
            );
            const firstSubmissionTimestampS = submissionContext.firstSubmissionTimestampS;
            RFQM_MINING_LATENCY.labels(this._chainId.toString()).observe(
                minedBlockTimestampS - firstSubmissionTimestampS,
            );
        } catch ({ message }) {
            logger.warn({ orderHash: job.orderHash, errorMessage: message }, 'Failed to meter the mining latency');
        }

        await submissionContext.updateForReceiptAsync(minedReceipt);

        const jobStatus = submissionContext.jobStatus;

        await Promise.all([
            this._dbUtils.updateRfqmTransactionSubmissionsAsync(submissionContext.transactions),
            this._dbUtils.updateRfqmJobAsync({ ..._job, status: jobStatus }),
        ]);

        return jobStatus;
    }

    /**
     * Determine transaction properties and submit a transaction
     */
    private async _submitTransactionAsync(
        orderHash: string,
        workerAddress: string,
        callData: string,
        gasFees: GasFees,
        nonce: number,
        gasEstimate: number,
    ): Promise<RfqmV2TransactionSubmissionEntity> {
        const txOptions = {
            ...gasFees,
            from: workerAddress,
            gas: gasEstimate,
            nonce,
            value: 0,
        };

        const transactionRequest = this._blockchainUtils.transformTxDataToTransactionRequest(
            txOptions,
            this._chainId,
            callData,
        );
        const { signedTransaction, transactionHash } = await this._blockchainUtils.signTransactionAsync(
            transactionRequest,
        );

        const partialEntity = {
            ...gasFees,
            transactionHash,
            orderHash,
            createdAt: new Date(),
            from: workerAddress,
            to: this._blockchainUtils.getExchangeProxyAddress(),
            nonce,
            status: RfqmTransactionSubmissionStatus.Presubmit,
        };

        const transactionSubmissionEntity = await this._dbUtils.writeV2RfqmTransactionSubmissionToDbAsync(
            partialEntity,
        );

        const transactionHashFromSubmit = await this._blockchainUtils.submitSignedTransactionAsync(signedTransaction);

        logger.info(
            { orderHash, workerAddress, transactionHash: transactionHashFromSubmit },
            'Transaction calldata submitted to exchange proxy',
        );

        const updatedTransactionSubmission = [
            {
                ...transactionSubmissionEntity,
                transactionHash: transactionHashFromSubmit,
                status: RfqmTransactionSubmissionStatus.Submitted,
            },
        ];

        await this._dbUtils.updateRfqmTransactionSubmissionsAsync(updatedTransactionSubmission);

        const updatedEntity = await this._dbUtils.findV2TransactionSubmissionByTransactionHashAsync(
            transactionHashFromSubmit,
        );

        if (!updatedEntity) {
            // This should never happen -- we just saved it
            throw new Error(`Could not find updated entity with transaction hash ${transactionHashFromSubmit}`);
        }

        return updatedEntity;
    }

    private async _enqueueJobAsync(orderHash: string, type: RfqmTypes): Promise<void> {
        await this._sqsProducer.send({
            // wait, it's all order hash?
            // always has been.
            groupId: orderHash,
            id: orderHash,
            body: JSON.stringify({ orderHash, type }),
            deduplicationId: orderHash,
        });
    }

    /**
     * Maps an IndicativeQuote to a FirmOtcQuote. Handles txOrigin, chainId, expiryAndNonce, etc
     */
    private _mapIndicativeQuoteToFirmOtcQuote(
        q: IndicativeQuote,
        takerAddress: string,
        nonceBucket: BigNumber,
        nonce: BigNumber,
    ): FirmOtcQuote {
        return {
            kind: 'otc',
            makerUri: q.makerUri,
            order: new OtcOrder({
                txOrigin: this._registryAddress,
                expiryAndNonce: OtcOrder.encodeExpiryAndNonce(q.expiry, nonceBucket, nonce),
                maker: q.maker,
                taker: takerAddress,
                makerToken: q.makerToken,
                takerToken: q.takerToken,
                makerAmount: q.makerAmount,
                takerAmount: q.takerAmount,
                chainId: this._chainId,
                verifyingContract: this._contractAddresses.exchangeProxy,
            }),
        };
    }

    /**
     * Takes an array of Transaction Submissions, which may include transactions with the
     * "Presbumit" status, and resolves or removes the "Presubmit" transactions.
     *
     * If there are previous submissions in the "Presubmit" state,
     *
     * For "Presubmit" transactions, we check to see if the transaction was actually sent to
     * the mempool or not, as that is indeterminate. Depending on the result of the check, we
     * update the status to "Submitted" or remove them from the submissions in memory.
     * Note that we leave the transaction record present in the database so that if the worker
     * dies again and the submission actually went through but was not found at the time of
     * this check we can potentially recover it later.
     */
    private async _recoverPresubmitTransactionsAsync(
        transactionSubmissions: RfqmV2TransactionSubmissionEntity[],
    ): Promise<RfqmV2TransactionSubmissionEntity[]> {
        // Any is so nasty -- https://dev.to/shadow1349/typescript-tip-of-the-week-generics-170g
        const result: any = await Promise.all(
            transactionSubmissions.map(async (transactionSubmission) => {
                // If the transaction is any status other than "Presubmit" then we'll leave it
                if (transactionSubmission.status !== RfqmTransactionSubmissionStatus.Presubmit) {
                    return transactionSubmission;
                }
                // For transactions in presubmit, check the mempool and chain to see if they exist
                const transactionResponse = await this._blockchainUtils.getTransactionAsync(
                    transactionSubmission.transactionHash!,
                );
                if (transactionResponse) {
                    // If it does exist, update the status. If not, remove it.
                    transactionSubmission.status = RfqmTransactionSubmissionStatus.Submitted;
                    await this._dbUtils.updateRfqmTransactionSubmissionsAsync([transactionSubmission]);
                    return transactionSubmission;
                } else {
                    return null;
                }
            }),
        ).then((x) => x.filter(isDefined));
        return result;
    }
}
