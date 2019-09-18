import { expect } from '@0x/contracts-test-utils';
import { BigNumber, RevertError } from '@0x/utils';
import * as _ from 'lodash';

import { StakingApiWrapper } from '../utils/api_wrapper';
import { StakeBalances, StakeInfo, StakeStatus } from '../utils/types';

import { BaseActor } from './base_actor';

export class StakerActor extends BaseActor {
    private readonly _poolIds: string[];

    constructor(owner: string, stakingApiWrapper: StakingApiWrapper) {
        super(owner, stakingApiWrapper);
        this._poolIds = [];
    }

    public async stakeAndMoveAsync(
        from: StakeInfo,
        to: StakeInfo,
        amount: BigNumber,
        revertError?: RevertError,
    ): Promise<void> {
        const initZrxBalanceOfVault = await this._stakingApiWrapper.utils.getZrxTokenBalanceOfZrxVaultAsync();
        const initStakerBalances = await this.getBalancesAsync();
        // move stake
        const txReceiptPromise = this._stakingApiWrapper.stakingProxyContract.batchExecute.awaitTransactionSuccessAsync(
            [
                this._stakingApiWrapper.stakingContract.stake.getABIEncodedTransactionData(amount),
                this._stakingApiWrapper.stakingContract.moveStake.getABIEncodedTransactionData(from, to, amount),
            ],
            { from: this._owner },
        );
        if (revertError !== undefined) {
            await expect(txReceiptPromise, 'expected revert error').to.revertWith(revertError);
            return;
        }
        await txReceiptPromise;
        // Calculate the expected stake amount.
        const expectedStakerBalances = await this._calculateExpectedBalancesAfterMoveAsync(
            from,
            to,
            amount,
            await this._calculateExpectedBalancesAfterStakeAsync(amount, initStakerBalances),
        );
        await this.assertBalancesAsync(expectedStakerBalances);
        // check zrx balance of vault
        const finalZrxBalanceOfVault = await this._stakingApiWrapper.utils.getZrxTokenBalanceOfZrxVaultAsync();
        expect(finalZrxBalanceOfVault, 'final balance of zrx vault').to.be.bignumber.equal(
            initZrxBalanceOfVault.plus(amount),
        );
    }

    public async stakeAsync(amount: BigNumber, revertError?: RevertError): Promise<void> {
        const initZrxBalanceOfVault = await this._stakingApiWrapper.utils.getZrxTokenBalanceOfZrxVaultAsync();
        const initStakerBalances = await this.getBalancesAsync();
        // deposit stake
        const txReceiptPromise = this._stakingApiWrapper.stakingContract.stake.awaitTransactionSuccessAsync(amount, {
            from: this._owner,
        });
        if (revertError !== undefined) {
            await expect(txReceiptPromise, 'expected revert error').to.revertWith(revertError);
            return;
        }
        await txReceiptPromise;
        // @TODO check receipt logs and return value via eth_call
        // check balances
        const expectedStakerBalances = await this._calculateExpectedBalancesAfterStakeAsync(amount, initStakerBalances);
        await this.assertBalancesAsync(expectedStakerBalances);
        // check zrx balance of vault
        const finalZrxBalanceOfVault = await this._stakingApiWrapper.utils.getZrxTokenBalanceOfZrxVaultAsync();
        expect(finalZrxBalanceOfVault, 'final balance of zrx vault').to.be.bignumber.equal(
            initZrxBalanceOfVault.plus(amount),
        );
    }

    public async unstakeAsync(amount: BigNumber, revertError?: RevertError): Promise<void> {
        const initZrxBalanceOfVault = await this._stakingApiWrapper.utils.getZrxTokenBalanceOfZrxVaultAsync();
        const initStakerBalances = await this.getBalancesAsync();
        // deposit stake
        const txReceiptPromise = this._stakingApiWrapper.stakingContract.unstake.awaitTransactionSuccessAsync(amount, {
            from: this._owner,
        });
        if (revertError !== undefined) {
            await expect(txReceiptPromise, 'expected revert error').to.revertWith(revertError);
            return;
        }
        await txReceiptPromise;
        // @TODO check receipt logs and return value via eth_call
        // check balances
        const expectedStakerBalances = initStakerBalances;
        expectedStakerBalances.zrxBalance = initStakerBalances.zrxBalance.plus(amount);
        expectedStakerBalances.stakeBalanceInVault = initStakerBalances.stakeBalanceInVault.minus(amount);
        expectedStakerBalances.inactiveStakeBalance.nextEpochBalance = initStakerBalances.inactiveStakeBalance.nextEpochBalance.minus(
            amount,
        );
        expectedStakerBalances.inactiveStakeBalance.currentEpochBalance = initStakerBalances.inactiveStakeBalance.currentEpochBalance.minus(
            amount,
        );
        expectedStakerBalances.withdrawableStakeBalance = initStakerBalances.withdrawableStakeBalance.minus(amount);
        await this.assertBalancesAsync(expectedStakerBalances);
        // check zrx balance of vault
        const finalZrxBalanceOfVault = await this._stakingApiWrapper.utils.getZrxTokenBalanceOfZrxVaultAsync();
        expect(finalZrxBalanceOfVault, 'final balance of zrx vault').to.be.bignumber.equal(
            initZrxBalanceOfVault.minus(amount),
        );
    }

    public async moveStakeAsync(
        from: StakeInfo,
        to: StakeInfo,
        amount: BigNumber,
        revertError?: RevertError,
    ): Promise<void> {
        // Cache Initial Balances.
        const initZrxBalanceOfVault = await this._stakingApiWrapper.utils.getZrxTokenBalanceOfZrxVaultAsync();
        // Calculate the expected outcome after the move.
        const expectedStakerBalances = await this._calculateExpectedBalancesAfterMoveAsync(from, to, amount);
        // move stake
        const txReceiptPromise = this._stakingApiWrapper.stakingContract.moveStake.awaitTransactionSuccessAsync(
            from,
            to,
            amount,
            { from: this._owner },
        );
        if (revertError !== undefined) {
            await expect(txReceiptPromise).to.revertWith(revertError);
            return;
        }
        await txReceiptPromise;
        // check balances
        await this.assertBalancesAsync(expectedStakerBalances);
        // check zrx balance of vault
        const finalZrxBalanceOfVault = await this._stakingApiWrapper.utils.getZrxTokenBalanceOfZrxVaultAsync();
        expect(finalZrxBalanceOfVault, 'final balance of zrx vault').to.be.bignumber.equal(initZrxBalanceOfVault);
    }

    public async goToNextEpochAsync(): Promise<void> {
        // cache balances
        const initZrxBalanceOfVault = await this._stakingApiWrapper.utils.getZrxTokenBalanceOfZrxVaultAsync();
        const initStakerBalances = await this.getBalancesAsync();
        // go to next epoch
        await this._stakingApiWrapper.utils.skipToNextEpochAsync();
        // check balances
        const expectedStakerBalances = this.getNextEpochBalances(initStakerBalances);
        await this.assertBalancesAsync(expectedStakerBalances);
        // check zrx balance of vault
        const finalZrxBalanceOfVault = await this._stakingApiWrapper.utils.getZrxTokenBalanceOfZrxVaultAsync();
        expect(finalZrxBalanceOfVault, 'final balance of zrx vault').to.be.bignumber.equal(initZrxBalanceOfVault);
    }

    public getNextEpochBalances(balances: StakeBalances): StakeBalances {
        const nextBalances = _.cloneDeep(balances);
        nextBalances.withdrawableStakeBalance = nextBalances.inactiveStakeBalance.nextEpochBalance.isLessThan(
            nextBalances.inactiveStakeBalance.currentEpochBalance,
        )
            ? nextBalances.inactiveStakeBalance.nextEpochBalance
            : nextBalances.inactiveStakeBalance.currentEpochBalance;
        nextBalances.activeStakeBalance.currentEpochBalance = nextBalances.activeStakeBalance.nextEpochBalance;
        nextBalances.inactiveStakeBalance.currentEpochBalance = nextBalances.inactiveStakeBalance.nextEpochBalance;
        nextBalances.delegatedStakeBalance.currentEpochBalance = nextBalances.delegatedStakeBalance.nextEpochBalance;
        for (const poolId of this._poolIds) {
            nextBalances.delegatedStakeByPool[poolId].currentEpochBalance =
                nextBalances.delegatedStakeByPool[poolId].nextEpochBalance;
            nextBalances.totalDelegatedStakeByPool[poolId].currentEpochBalance =
                nextBalances.totalDelegatedStakeByPool[poolId].nextEpochBalance;
        }
        return nextBalances;
    }
    public async getBalancesAsync(): Promise<StakeBalances> {
        const stakerBalances: StakeBalances = {
            zrxBalance: await this._stakingApiWrapper.zrxTokenContract.balanceOf.callAsync(this._owner),
            stakeBalance: await this._stakingApiWrapper.stakingContract.getTotalStake.callAsync(this._owner),
            stakeBalanceInVault: await this._stakingApiWrapper.zrxVaultContract.balanceOf.callAsync(this._owner),
            withdrawableStakeBalance: await this._stakingApiWrapper.stakingContract.getWithdrawableStake.callAsync(
                this._owner,
            ),
            activeStakeBalance: await this._stakingApiWrapper.stakingContract.getActiveStake.callAsync(this._owner),
            inactiveStakeBalance: await this._stakingApiWrapper.stakingContract.getInactiveStake.callAsync(this._owner),
            delegatedStakeBalance: await this._stakingApiWrapper.stakingContract.getStakeDelegatedByOwner.callAsync(
                this._owner,
            ),
            delegatedStakeByPool: {},
            totalDelegatedStakeByPool: {},
        };
        // lookup for each pool
        for (const poolId of this._poolIds) {
            const delegatedStakeBalanceByPool = await this._stakingApiWrapper.stakingContract.getStakeDelegatedToPoolByOwner.callAsync(
                this._owner,
                poolId,
            );
            const totalDelegatedStakeBalanceByPool = await this._stakingApiWrapper.stakingContract.getTotalStakeDelegatedToPool.callAsync(
                poolId,
            );
            stakerBalances.delegatedStakeByPool[poolId] = delegatedStakeBalanceByPool;
            stakerBalances.totalDelegatedStakeByPool[poolId] = totalDelegatedStakeBalanceByPool;
        }
        return stakerBalances;
    }
    public async assertBalancesAsync(expectedBalances: StakeBalances): Promise<void> {
        const balances = await this.getBalancesAsync();
        expect(balances.zrxBalance, 'zrx balance').to.be.bignumber.equal(expectedBalances.zrxBalance);
        expect(balances.stakeBalanceInVault, 'stake balance, recorded in vault').to.be.bignumber.equal(
            expectedBalances.stakeBalanceInVault,
        );
        expect(balances.withdrawableStakeBalance, 'withdrawable stake balance').to.be.bignumber.equal(
            expectedBalances.withdrawableStakeBalance,
        );
        expect(balances.activeStakeBalance.currentEpochBalance, 'active stake balance (current)').to.be.bignumber.equal(
            expectedBalances.activeStakeBalance.currentEpochBalance,
        );
        expect(balances.activeStakeBalance.nextEpochBalance, 'active stake balance (next)').to.be.bignumber.equal(
            expectedBalances.activeStakeBalance.nextEpochBalance,
        );
        expect(
            balances.inactiveStakeBalance.currentEpochBalance,
            'inactive stake balance (current)',
        ).to.be.bignumber.equal(expectedBalances.inactiveStakeBalance.currentEpochBalance);
        expect(balances.inactiveStakeBalance.nextEpochBalance, 'inactive stake balance (next)').to.be.bignumber.equal(
            expectedBalances.inactiveStakeBalance.nextEpochBalance,
        );
        expect(
            balances.delegatedStakeBalance.currentEpochBalance,
            'delegated stake balance (current)',
        ).to.be.bignumber.equal(expectedBalances.delegatedStakeBalance.currentEpochBalance);
        expect(balances.delegatedStakeBalance.nextEpochBalance, 'delegated stake balance (next)').to.be.bignumber.equal(
            expectedBalances.delegatedStakeBalance.nextEpochBalance,
        );
        expect(balances.delegatedStakeByPool, 'delegated stake by pool').to.be.deep.equal(
            expectedBalances.delegatedStakeByPool,
        );
        expect(balances.totalDelegatedStakeByPool, 'total delegated stake by pool').to.be.deep.equal(
            expectedBalances.totalDelegatedStakeByPool,
        );
    }
    public async forceBalanceSyncAsync(): Promise<void> {
        const initBalances = await this.getBalancesAsync();
        await this._stakingApiWrapper.stakingContract.stake.awaitTransactionSuccessAsync(new BigNumber(0), {
            from: this._owner,
        });
        await this.assertBalancesAsync(initBalances);
    }

    private async _calculateExpectedBalancesAfterMoveAsync(
        from: StakeInfo,
        to: StakeInfo,
        amount: BigNumber,
        initStakerBalances?: StakeBalances,
    ): Promise<StakeBalances> {
        // check if we're moving stake into a new pool
        if (to.status === StakeStatus.Delegated && to.poolId !== undefined && !_.includes(this._poolIds, to.poolId)) {
            this._poolIds.push(to.poolId);
        }
        // cache balances
        const initialStakerBalances = initStakerBalances || (await this.getBalancesAsync());
        // @TODO check receipt logs and return value via eth_call
        // check balances
        const expectedStakerBalances = initialStakerBalances;
        // from
        if (from.status === StakeStatus.Active) {
            expectedStakerBalances.activeStakeBalance.nextEpochBalance = initialStakerBalances.activeStakeBalance.nextEpochBalance.minus(
                amount,
            );
        } else if (from.status === StakeStatus.Inactive) {
            expectedStakerBalances.inactiveStakeBalance.nextEpochBalance = initialStakerBalances.inactiveStakeBalance.nextEpochBalance.minus(
                amount,
            );
            if (
                expectedStakerBalances.inactiveStakeBalance.nextEpochBalance.isLessThan(
                    expectedStakerBalances.withdrawableStakeBalance,
                )
            ) {
                expectedStakerBalances.withdrawableStakeBalance =
                    expectedStakerBalances.inactiveStakeBalance.nextEpochBalance;
            }
        } else if (from.status === StakeStatus.Delegated && from.poolId !== undefined) {
            expectedStakerBalances.delegatedStakeBalance.nextEpochBalance = initialStakerBalances.delegatedStakeBalance.nextEpochBalance.minus(
                amount,
            );
            expectedStakerBalances.delegatedStakeByPool[
                from.poolId
            ].nextEpochBalance = initialStakerBalances.delegatedStakeByPool[from.poolId].nextEpochBalance.minus(amount);
            expectedStakerBalances.totalDelegatedStakeByPool[
                from.poolId
            ].nextEpochBalance = initialStakerBalances.totalDelegatedStakeByPool[from.poolId].nextEpochBalance.minus(
                amount,
            );
        }
        // to
        if (to.status === StakeStatus.Active) {
            expectedStakerBalances.activeStakeBalance.nextEpochBalance = initialStakerBalances.activeStakeBalance.nextEpochBalance.plus(
                amount,
            );
        } else if (to.status === StakeStatus.Inactive) {
            expectedStakerBalances.inactiveStakeBalance.nextEpochBalance = initialStakerBalances.inactiveStakeBalance.nextEpochBalance.plus(
                amount,
            );
        } else if (to.status === StakeStatus.Delegated && to.poolId !== undefined) {
            expectedStakerBalances.delegatedStakeBalance.nextEpochBalance = initialStakerBalances.delegatedStakeBalance.nextEpochBalance.plus(
                amount,
            );
            expectedStakerBalances.delegatedStakeByPool[
                to.poolId
            ].nextEpochBalance = initialStakerBalances.delegatedStakeByPool[to.poolId].nextEpochBalance.plus(amount);
            expectedStakerBalances.totalDelegatedStakeByPool[
                to.poolId
            ].nextEpochBalance = initialStakerBalances.totalDelegatedStakeByPool[to.poolId].nextEpochBalance.plus(
                amount,
            );
        }
        return expectedStakerBalances;
    }

    private async _calculateExpectedBalancesAfterStakeAsync(
        amount: BigNumber,
        initStakerBalances?: StakeBalances,
    ): Promise<StakeBalances> {
        const initialStakerBalances = initStakerBalances || (await this.getBalancesAsync());
        // check balances
        const expectedStakerBalances = initialStakerBalances;
        expectedStakerBalances.zrxBalance = initialStakerBalances.zrxBalance.minus(amount);
        expectedStakerBalances.stakeBalanceInVault = initialStakerBalances.stakeBalanceInVault.plus(amount);
        expectedStakerBalances.activeStakeBalance.currentEpochBalance = initialStakerBalances.activeStakeBalance.currentEpochBalance.plus(
            amount,
        );
        expectedStakerBalances.activeStakeBalance.nextEpochBalance = initialStakerBalances.activeStakeBalance.nextEpochBalance.plus(
            amount,
        );
        return expectedStakerBalances;
    }
}