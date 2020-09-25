import { BigNumber } from '@ethersproject/bignumber'
import { TransactionResponse } from '@ethersproject/providers'
import { Currency, currencyEquals, ETHER, TokenAmount, WETH } from '@uniswap/sdk'
import React, { useCallback, useContext, useState } from 'react'
import { Plus } from 'react-feather'
import ReactGA from 'react-ga'
import { RouteComponentProps } from 'react-router-dom'
import { Text } from 'rebass'
import { ThemeContext } from 'styled-components'
import { ButtonError, ButtonLight, ButtonPrimary } from '../../components/Button'
import { BlueCard, GreyCard, LightCard } from '../../components/Card'
import { AutoColumn, ColumnCenter } from '../../components/Column'
import TransactionConfirmationModal, { ConfirmationModalContent } from '../../components/TransactionConfirmationModal'
import CurrencyInputPanel from '../../components/CurrencyInputPanel'
import DoubleCurrencyLogo from '../../components/DoubleLogo'
import { AddRemoveTabs } from '../../components/NavigationTabs'
import { MinimalPositionCard } from '../../components/PositionCard'
import Row, { RowBetween, RowFlat } from '../../components/Row'

import { HELPERV1_ADDRESS } from '../../constants'
import { PairState } from '../../data/Reserves'
import { useActiveWeb3React } from '../../hooks'
import { useCurrency } from '../../hooks/Tokens'
import { ApprovalState, useApproveCallback } from '../../hooks/useApproveCallback'
import { useWalletModalToggle } from '../../state/application/hooks'
import { Field } from '../../state/mint/actions'
import { useDerivedMintInfo, useMintActionHandlers, useMintState } from '../../state/mint/hooks'

import { useTransactionAdder } from '../../state/transactions/hooks'
import { useIsExpertMode, useUserDeadline, useUserSlippageTolerance } from '../../state/user/hooks'
import { ExternalLink, TYPE } from '../../theme'
import { calculateGasMargin, /*calculateSlippageAmount, /*getRouterContract,*/ getHelperContract } from '../../utils'
import { maxAmountSpend } from '../../utils/maxAmountSpend'
import { wrappedCurrency } from '../../utils/wrappedCurrency'
import AppBody from '../AppBody'
import { Dots, Wrapper } from '../Pool/styleds'
import { ConfirmAddModalBottom } from './ConfirmAddModalBottom'
import { currencyId } from '../../utils/currencyId'
import { PoolPriceBar } from './PoolPriceBar'

export default function AddLiquidity({
  match: {
    params: { currencyIdA, currencyIdB }
  },
  history
}: RouteComponentProps<{ currencyIdA?: string; currencyIdB?: string }>) {
  const { account, chainId, library } = useActiveWeb3React()
  const theme = useContext(ThemeContext)

  const currencyA = useCurrency(currencyIdA)
  const currencyB = useCurrency(currencyIdB)

  const oneCurrencyIsWETH = Boolean(
    chainId &&
      ((currencyA && currencyEquals(currencyA, WETH[chainId])) ||
        (currencyB && currencyEquals(currencyB, WETH[chainId])))
  )

  const toggleWalletModal = useWalletModalToggle() // toggle wallet when disconnected

  const expertMode = useIsExpertMode()

  // mint state
  const { independentField, typedValue, otherTypedValue } = useMintState()
  const {
    dependentField,
    currencies,
    pair,
    pairState,
    currencyBalances,
    parsedAmounts,
    price,
    noLiquidity,
    anyRatio,
    liquidityMinted,
    poolTokenPercentage,
    error
  } = useDerivedMintInfo(currencyA ?? undefined, currencyB ?? undefined)
  const { onFieldAInput, onFieldBInput } = useMintActionHandlers(noLiquidity, anyRatio)

  const isValid = !error

  // modal and loading
  const [showConfirm, setShowConfirm] = useState<boolean>(false)
  const [attemptingTxn, setAttemptingTxn] = useState<boolean>(false) // clicked confirm

  // txn values
  const [deadline] = useUserDeadline() // custom from users settings
  const [allowedSlippage] = useUserSlippageTolerance() // custom from users
  const [txHash, setTxHash] = useState<string>('')

  // get formatted amounts
  const formattedAmounts = {
    [independentField]: typedValue,
    [dependentField]: (noLiquidity || anyRatio) ? otherTypedValue : parsedAmounts[dependentField]?.toSignificant(6) ?? ''
  }

  // get the max amounts user can add
  const maxAmounts: { [field in Field]?: TokenAmount } = [Field.CURRENCY_A, Field.CURRENCY_B].reduce(
    (accumulator, field) => {
      return {
        ...accumulator,
        [field]: maxAmountSpend(currencyBalances[field])
      }
    },
    {}
  )

  const atMaxAmounts: { [field in Field]?: TokenAmount } = [Field.CURRENCY_A, Field.CURRENCY_B].reduce(
    (accumulator, field) => {
      return {
        ...accumulator,
        [field]: maxAmounts[field]?.equalTo(parsedAmounts[field] ?? '0')
      }
    },
    {}
  )

  // check whether the user has approved the helper on the tokens
  const [approvalA, approveACallback] = useApproveCallback(parsedAmounts[Field.CURRENCY_A], HELPERV1_ADDRESS)
  const [approvalB, approveBCallback] = useApproveCallback(parsedAmounts[Field.CURRENCY_B], HELPERV1_ADDRESS)

  const addTransaction = useTransactionAdder()

  async function onAdd() {
    if (!chainId || !library || !account) return
    // const router = getRouterContract(chainId, library, account)
    const helper = getHelperContract(chainId, library, account)

    const { [Field.CURRENCY_A]: parsedAmountA, [Field.CURRENCY_B]: parsedAmountB } = parsedAmounts
    if (!parsedAmountA || !parsedAmountB || !currencyA || !currencyB) {
      return
    }

    // const amountsMin = {
    //   [Field.CURRENCY_A]: calculateSlippageAmount(parsedAmountA, noLiquidity ? 0 : allowedSlippage)[0],
    //   [Field.CURRENCY_B]: calculateSlippageAmount(parsedAmountB, noLiquidity ? 0 : allowedSlippage)[0]
    // }

    const deadlineFromNow = Math.ceil(Date.now() / 1000) + deadline

    let estimate,
      method: (...args: any) => Promise<TransactionResponse>,
      args: Array<string | string[] | number>,
      value: BigNumber | null
    if (currencyA === ETHER || currencyB === ETHER) {
      const tokenBIsETH = currencyB === ETHER
      // estimate = router.estimateGas.addLiquidityETH
      // method = router.addLiquidityETH
      // args = [
      //   wrappedCurrency(tokenBIsETH ? currencyA : currencyB, chainId)?.address ?? '', // token
      //   (tokenBIsETH ? parsedAmountA : parsedAmountB).raw.toString(), // token desired
      //   amountsMin[tokenBIsETH ? Field.CURRENCY_A : Field.CURRENCY_B].toString(), // token min
      //   amountsMin[tokenBIsETH ? Field.CURRENCY_B : Field.CURRENCY_A].toString(), // eth min
      //   account,
      //   deadlineFromNow
      // ]
      // value = BigNumber.from((tokenBIsETH ? parsedAmountB : parsedAmountA).raw.toString())
      estimate = helper.estimateGas.swapAndAddLiquidityEthAndToken
      method = helper.swapAndAddLiquidityEthAndToken
      args = [
        wrappedCurrency(tokenBIsETH ? currencyA : currencyB, chainId)?.address ?? '', // tokenAddressB
        (tokenBIsETH ? parsedAmountA : parsedAmountB).raw.toString(), // amountB
        '1', // minLiquidityOut
        account, // to
        deadlineFromNow
      ]
      value = BigNumber.from((tokenBIsETH ? parsedAmountB : parsedAmountA).raw.toString())
    } else {
      // estimate = router.estimateGas.addLiquidity
      // method = router.addLiquidity
      // args = [
      //   wrappedCurrency(currencyA, chainId)?.address ?? '',
      //   wrappedCurrency(currencyB, chainId)?.address ?? '',
      //   parsedAmountA.raw.toString(),
      //   parsedAmountB.raw.toString(),
      //   amountsMin[Field.CURRENCY_A].toString(),
      //   amountsMin[Field.CURRENCY_B].toString(),
      //   account,
      //   deadlineFromNow
      // ]
      // value = null
      estimate = helper.estimateGas.swapAndAddLiquidityTokenAndToken
      method = helper.swapAndAddLiquidityTokenAndToken
      args = [
        wrappedCurrency(currencyA, chainId)?.address ?? '',
        wrappedCurrency(currencyB, chainId)?.address ?? '',
        parsedAmountA.raw.toString(),
        parsedAmountB.raw.toString(),
        account,
        deadlineFromNow
      ]
      value = null
    }

    setAttemptingTxn(true)
    await estimate(...args, value ? { value } : {})
      .then(estimatedGasLimit =>
        method(...args, {
          ...(value ? { value } : {}),
          gasLimit: calculateGasMargin(estimatedGasLimit)
        }).then(response => {
          setAttemptingTxn(false)

          addTransaction(response, {
            summary:
              'Add ' +
              parsedAmounts[Field.CURRENCY_A]?.toSignificant(3) +
              ' ' +
              currencies[Field.CURRENCY_A]?.symbol +
              ' and ' +
              parsedAmounts[Field.CURRENCY_B]?.toSignificant(3) +
              ' ' +
              currencies[Field.CURRENCY_B]?.symbol
          })

          setTxHash(response.hash)

          ReactGA.event({
            category: 'Liquidity',
            action: 'Add',
            label: [currencies[Field.CURRENCY_A]?.symbol, currencies[Field.CURRENCY_B]?.symbol].join('/')
          })
        })
      )
      .catch(error => {
        setAttemptingTxn(false)
        // we only care if the error is something _other_ than the user rejected the tx
        if (error?.code !== 4001) {
          console.error(error)
        }
      })
  }

  const modalHeader = () => {
    return noLiquidity ? (
      <AutoColumn gap="20px">
        <LightCard mt="20px" borderRadius="20px">
          <RowFlat>
            <Text fontSize="48px" fontWeight={500} lineHeight="42px" marginRight={10}>
              {currencies[Field.CURRENCY_A]?.symbol + '/' + currencies[Field.CURRENCY_B]?.symbol}
            </Text>
            <DoubleCurrencyLogo
              currency0={currencies[Field.CURRENCY_A]}
              currency1={currencies[Field.CURRENCY_B]}
              size={30}
            />
          </RowFlat>
        </LightCard>
      </AutoColumn>
    ) : (
      <AutoColumn gap="20px">
        <RowFlat style={{ marginTop: '20px' }}>
          <Text fontSize="48px" fontWeight={500} lineHeight="42px" marginRight={10}>
            {liquidityMinted?.toSignificant(6)}
          </Text>
          <DoubleCurrencyLogo
            currency0={currencies[Field.CURRENCY_A]}
            currency1={currencies[Field.CURRENCY_B]}
            size={30}
          />
        </RowFlat>
        <Row>
          <Text fontSize="24px">
            {currencies[Field.CURRENCY_A]?.symbol + '/' + currencies[Field.CURRENCY_B]?.symbol + ' Pool Tokens'}
          </Text>
        </Row>
        <TYPE.italic fontSize={12} textAlign="left" padding={'8px 0 0 0 '}>
          {`Output is estimated. If the price changes by more than ${allowedSlippage /
            100}% your transaction will revert.`}
        </TYPE.italic>
      </AutoColumn>
    )
  }

  const modalBottom = () => {
    return (
      <ConfirmAddModalBottom
        price={price}
        currencies={currencies}
        parsedAmounts={parsedAmounts}
        noLiquidity={noLiquidity}
        onAdd={onAdd}
        poolTokenPercentage={poolTokenPercentage}
      />
    )
  }

  const pendingText = `Supplying ${parsedAmounts[Field.CURRENCY_A]?.toSignificant(6)} ${
    currencies[Field.CURRENCY_A]?.symbol
  } and ${parsedAmounts[Field.CURRENCY_B]?.toSignificant(6)} ${currencies[Field.CURRENCY_B]?.symbol}`

  const handleCurrencyASelect = useCallback(
    (currencyA: Currency) => {
      const newCurrencyIdA = currencyId(currencyA)
      if (newCurrencyIdA === currencyIdB) {
        history.push(`/add/${currencyIdB}/${currencyIdA}`)
      } else {
        history.push(`/add/${newCurrencyIdA}/${currencyIdB}`)
      }
    },
    [currencyIdB, history, currencyIdA]
  )
  const handleCurrencyBSelect = useCallback(
    (currencyB: Currency) => {
      const newCurrencyIdB = currencyId(currencyB)
      if (currencyIdA === newCurrencyIdB) {
        if (currencyIdB) {
          history.push(`/add/${currencyIdB}/${newCurrencyIdB}`)
        } else {
          history.push(`/add/${newCurrencyIdB}`)
        }
      } else {
        history.push(`/add/${currencyIdA ? currencyIdA : 'ETH'}/${newCurrencyIdB}`)
      }
    },
    [currencyIdA, history, currencyIdB]
  )

  const handleDismissConfirmation = useCallback(() => {
    setShowConfirm(false)
    // if there was a tx hash, we want to clear the input
    if (txHash) {
      onFieldAInput('')
    }
    setTxHash('')
  }, [onFieldAInput, txHash])

  return (
    <>
      <AppBody>
        <AddRemoveTabs adding={true} />
        <Wrapper>
          <TransactionConfirmationModal
            isOpen={showConfirm}
            onDismiss={handleDismissConfirmation}
            attemptingTxn={attemptingTxn}
            hash={txHash}
            content={() => (
              <ConfirmationModalContent
                title={noLiquidity ? 'You are creating a pool' : 'You will receive'}
                onDismiss={handleDismissConfirmation}
                topContent={modalHeader}
                bottomContent={modalBottom}
              />
            )}
            pendingText={pendingText}
          />
          <AutoColumn gap="20px">
            {noLiquidity && (
              <ColumnCenter>
                <BlueCard>
                  <AutoColumn gap="10px">
                    <TYPE.link fontWeight={600} color={'primaryText1'}>
                      You are the first liquidity provider.
                    </TYPE.link>
                    <TYPE.link fontWeight={400} color={'primaryText1'}>
                      The ratio of tokens you add will set the price of this pool.
                    </TYPE.link>
                    <TYPE.link fontWeight={400} color={'primaryText1'}>
                      Once you are happy with the rate click supply to review.
                    </TYPE.link>
                  </AutoColumn>
                </BlueCard>
              </ColumnCenter>
            )}
            <CurrencyInputPanel
              value={formattedAmounts[Field.CURRENCY_A]}
              onUserInput={onFieldAInput}
              onMax={() => {
                onFieldAInput(maxAmounts[Field.CURRENCY_A]?.toExact() ?? '')
              }}
              onCurrencySelect={handleCurrencyASelect}
              showMaxButton={!atMaxAmounts[Field.CURRENCY_A]}
              currency={currencies[Field.CURRENCY_A]}
              id="add-liquidity-input-tokena"
              showCommonBases
            />
            <ColumnCenter>
              <Plus size="16" color={theme.text2} />
            </ColumnCenter>
            <CurrencyInputPanel
              value={formattedAmounts[Field.CURRENCY_B]}
              onUserInput={onFieldBInput}
              onCurrencySelect={handleCurrencyBSelect}
              onMax={() => {
                onFieldBInput(maxAmounts[Field.CURRENCY_B]?.toExact() ?? '')
              }}
              showMaxButton={!atMaxAmounts[Field.CURRENCY_B]}
              currency={currencies[Field.CURRENCY_B]}
              id="add-liquidity-input-tokenb"
              showCommonBases
            />
            {currencies[Field.CURRENCY_A] && currencies[Field.CURRENCY_B] && pairState !== PairState.INVALID && (
              <>
                <GreyCard padding="0px" borderRadius={'20px'}>
                  <RowBetween padding="1rem">
                    <TYPE.subHeader fontWeight={500} fontSize={14}>
                      {noLiquidity ? 'Initial prices' : 'Prices'} and pool share
                    </TYPE.subHeader>
                  </RowBetween>{' '}
                  <LightCard padding="1rem" borderRadius={'20px'}>
                    <PoolPriceBar
                      currencies={currencies}
                      poolTokenPercentage={poolTokenPercentage}
                      noLiquidity={noLiquidity}
                      price={price}
                    />
                  </LightCard>
                </GreyCard>
              </>
            )}

            {!account ? (
              <ButtonLight onClick={toggleWalletModal}>Connect Wallet</ButtonLight>
            ) : (
              <AutoColumn gap={'md'}>
                {(approvalA === ApprovalState.NOT_APPROVED ||
                  approvalA === ApprovalState.PENDING ||
                  approvalB === ApprovalState.NOT_APPROVED ||
                  approvalB === ApprovalState.PENDING) &&
                  isValid && (
                    <RowBetween>
                      {approvalA !== ApprovalState.APPROVED && (
                        <ButtonPrimary
                          onClick={approveACallback}
                          disabled={approvalA === ApprovalState.PENDING}
                          width={approvalB !== ApprovalState.APPROVED ? '48%' : '100%'}
                        >
                          {approvalA === ApprovalState.PENDING ? (
                            <Dots>Approving {currencies[Field.CURRENCY_A]?.symbol}</Dots>
                          ) : (
                            'Approve ' + currencies[Field.CURRENCY_A]?.symbol
                          )}
                        </ButtonPrimary>
                      )}
                      {approvalB !== ApprovalState.APPROVED && (
                        <ButtonPrimary
                          onClick={approveBCallback}
                          disabled={approvalB === ApprovalState.PENDING}
                          width={approvalA !== ApprovalState.APPROVED ? '48%' : '100%'}
                        >
                          {approvalB === ApprovalState.PENDING ? (
                            <Dots>Approving {currencies[Field.CURRENCY_B]?.symbol}</Dots>
                          ) : (
                            'Approve ' + currencies[Field.CURRENCY_B]?.symbol
                          )}
                        </ButtonPrimary>
                      )}
                    </RowBetween>
                  )}
                <ButtonError
                  onClick={() => {
                    expertMode ? onAdd() : setShowConfirm(true)
                  }}
                  disabled={!isValid || approvalA !== ApprovalState.APPROVED || approvalB !== ApprovalState.APPROVED} // !isValid ||
                  error={!isValid && !!parsedAmounts[Field.CURRENCY_A] && !!parsedAmounts[Field.CURRENCY_B]}
                >
                  <Text fontSize={20} fontWeight={500}>
                    {error ?? 'Supply'}
                  </Text>
                </ButtonError>
              </AutoColumn>
            )}
          </AutoColumn>
        </Wrapper>
      </AppBody>

      {pair && !noLiquidity && pairState !== PairState.INVALID ? (
        <AutoColumn style={{ minWidth: '20rem', marginTop: '1rem', marginBottom: '1rem' }}>
          <MinimalPositionCard showUnwrapped={oneCurrencyIsWETH} pair={pair} />
        </AutoColumn>
      ) : null}

      <AppBody>
        <Wrapper>
          <AutoColumn>

            <ColumnCenter>
              <GreyCard>
                <AutoColumn gap="10px">
                  <TYPE.link fontWeight={400} color={'text2'}>
                    This is not an official tool.
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}></TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}></TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    This tool helps you add any ratio of tokens or ETH to a Uniswap pair.
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    With this tool, for example, if there are 1 ETH + 400 DAI in a pair,
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    you can add (1 ETH + 100 DAI) or (1 ETH + 0 DAI) or (0 ETH + 100 DAI) to the pool in one transaction.
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    Behind the scenes, the contract swaps part of your token (or ETH) to the other token (or ETH) and then adds them all to the pair.
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    The contract will find the best amount to swap to maximize the amount added into the pair.
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}></TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}></TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    The source code can be found on <ExternalLink href={`https://etherscan.io/address/${HELPERV1_ADDRESS}#code`}>Etherscan</ExternalLink> and <ExternalLink href="https://github.com/Roger-Wu/uniswap-v2-periphery">GitHub</ExternalLink>.
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    The contract is tested but not fully audited,
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    but if there's a serious flaw in our contract,
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    Uniswap's Router will still revert the transaction,
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    so your funds will be safe.
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    Still, use at your own risk.
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}></TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}></TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    Due to the inaccuracy of sqrt and division, if the amount to add is too small, the transaction may fail.
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    For example, adding 0.1 ETH to ETH-USDT pair may be ok, but adding 0.01 ETH to the same pair may fail.
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    We are still trying to fix this problem.
                  </TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}></TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}></TYPE.link>
                  <TYPE.link fontWeight={400} color={'text2'}>
                    There is no extra fee because we don't want to waste more gas just to charge ourselves. <span role="img" aria-label="Slightly Smiling Face">😄</span>
                  </TYPE.link>
                </AutoColumn>
              </GreyCard>
            </ColumnCenter>

          </AutoColumn>
        </Wrapper>
      </AppBody>
    </>
  )
}
