import {
    Config,
    getPerpMarketByBaseSymbol,
    getSpotMarketByBaseSymbol,
    getTokenBySymbol,
    I64_MAX_BN,
    makeCancelAllPerpOrdersInstruction,
    makePlacePerpOrder2Instruction,
    makePlaceSpotOrder2Instruction,
    MangoAccount,
    MangoClient,
    MangoGroup,
    nativeToUi,
    Payer,
    QUOTE_INDEX,
    ZERO_BN
} from "@blockworks-foundation/mango-client";
import {Connection, Keypair, PublicKey, Transaction} from "@solana/web3.js";
import fs from "fs";
import {BN} from "bn.js";
import child_process from "child_process";
import {getFeeRates, getFeeTier, Market} from "@project-serum/serum";
import {range, zip} from "lodash";
import {MangoRiskCheck, ViolationBehaviour} from "mango_risk_check";
import WebSocket from "ws";

const main = async () => {
    const {
        KEYPAIR_PATH,
        MANGO_GROUP,
        MANGO_ACCOUNT,
        SYMBOL
    } = process.env

    const config = Config.ids()

    const mangoGroupConfig = config.getGroupWithName(MANGO_GROUP || 'devnet.2')

    if (!mangoGroupConfig) {
        console.log(`Couldn't find group by name ${MANGO_GROUP}`)

        return
    }

    const [token, perpMarketConfig, spotMarketConfig] = [
        getTokenBySymbol(mangoGroupConfig, SYMBOL!),
        getPerpMarketByBaseSymbol(mangoGroupConfig, SYMBOL!),
        getSpotMarketByBaseSymbol(mangoGroupConfig, SYMBOL!)
    ]

    if (!token || !perpMarketConfig || !spotMarketConfig) {
        console.log(`token, perpMarketConfig or spotMarketConfig by symbol ${SYMBOL!} not found`)

        return
    }

    const connection = new Connection(config.cluster_urls[mangoGroupConfig.cluster], 'processed')

    const mangoClient = new MangoClient(connection, mangoGroupConfig.mangoProgramId)

    const mangoGroup = await mangoClient.getMangoGroup(mangoGroupConfig.publicKey)

    const [mangoCache, rootBanks, perpMarket, spotMarket] = await Promise.all([
        mangoGroup.loadCache(connection),
        mangoGroup.loadRootBanks(connection),
        mangoGroup.loadPerpMarket(
            connection,
            perpMarketConfig.marketIndex,
            perpMarketConfig.baseDecimals,
            perpMarketConfig.quoteDecimals
        ),
        Market.load(
            connection,
            spotMarketConfig.publicKey,
            undefined,
            mangoGroupConfig.serumProgramId
        )
    ])

    // The last updated timestamp for the cached token oracle price is logged
    // to check whether it hasn't updated in too long of a while
    let [tokenPrice, tokenPriceLastUpdated] = [
        mangoGroup.cachePriceToUi(
            mangoCache.getPrice(mangoGroup.getTokenIndex(token.mintKey)), mangoGroup.getTokenIndex(token.mintKey)
        ),
        new Date()
    ]

    mangoGroup.onCacheChange(connection, (mangoCache) => {
        [tokenPrice, tokenPriceLastUpdated] = [
            mangoGroup.cachePriceToUi(
                mangoCache.getPrice(mangoGroup.getTokenIndex(token.mintKey)), mangoGroup.getTokenIndex(token.mintKey)
            ),
            new Date()
        ]
    })

    // Transactions require a recent blockHash in order to be signed - we poll this
    // regularly in a separate thread to prevent the extra RPC call slowing down quotes
    let recentBlockhash = await connection.getLatestBlockhash('finalized')

    let blockHeight = await connection.getSlot('finalized')

    let blockTime = await connection.getBlockTime(blockHeight)

    async function pollRecentBlockhash() {
        recentBlockhash = await connection.getLatestBlockhash('finalized')

        blockHeight = await connection.getSlot('finalized')

        blockTime = await connection.getBlockTime(blockHeight)
    }

    setInterval(pollRecentBlockhash, 5000)

    const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR_PATH!, 'utf-8'))))

    const mangoAccount = await mangoClient.getMangoAccount(new PublicKey(MANGO_ACCOUNT!), mangoGroup.dexProgramId)

    const ws = new WebSocket('ws://localhost:8010/v1/ws')

    ws.onopen = (event) => {
        ws.send(JSON.stringify({
            'op': 'subscribe',
            'channel': 'level3',
            'markets': ['SOL-PERP']
        }))
    }

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data.toString())

        const { type, maker, account } = data

        const hit = type === 'fill' && maker && account === MANGO_ACCOUNT

        if (!hit) {
            return
        }

        const { side, price, size } = data

        // @ts-ignore
        const counterside = { buy: 'sell', sell: 'buy' }[side]

        console.log(`Got ${side} hit for ${size} @ $${price}, hedging on ${counterside}...`)

        const tx = new Transaction({
            recentBlockhash: recentBlockhash.blockhash,
            feePayer: payer.publicKey
        })

        const instruction = await createSpotOrder2Instruction(
            mangoClient,
            mangoGroup,
            mangoAccount,
            spotMarket,
            payer,
            counterside,
            price,
            size,
            'ioc',
            undefined,
            true
        )

        tx.add(instruction!)

        tx.sign(payer)

        const meta = `${[price, size]}`

        try {
            const response = await mangoClient.sendSignedTransaction({
                signedTransaction: tx,
                signedAtBlock: recentBlockhash,
            });

            console.log('hedge::response', meta, response);
        } catch (error) {
            console.log('hedge::error', meta, error);
        }
    }

    const riskChecker = new MangoRiskCheck({
        connection: connection,
        // @ts-ignore
        mangoAccount: mangoAccount,
        // @ts-ignore
        mangoClient: mangoClient,
        // @ts-ignore
        mangoGroup: mangoGroup,
        owner: payer
    })

    if (!(await riskChecker.getRiskAccount(perpMarketConfig))) {
        console.log('Risk check account not found, creating one...')

        await riskChecker.initializeRiskAccount(perpMarketConfig)

        console.log('Risk check account created!')
    }

    await Promise.all([
        riskChecker.setMaxOpenOrders(perpMarketConfig, 2),
        // @ts-ignore
        riskChecker.setMaxLongExposure(perpMarketConfig, perpMarket,50),
        // @ts-ignore
        riskChecker.setMaxShortExposure(perpMarketConfig, perpMarket, 50),
        riskChecker.setViolationBehaviour(perpMarketConfig, ViolationBehaviour.CancelIncreasingOrders)
    ])

    const quote = async () => {
        const spread = tokenPrice! * 0.001

        const [bidPrice, bidSize] = perpMarket.uiToNativePriceQuantity(tokenPrice! - spread, Math.floor(Math.random() * 10))

        const [askPrice, askSize] = perpMarket.uiToNativePriceQuantity(tokenPrice! + spread, Math.floor(Math.random() * 10))

        const tx = new Transaction({
            recentBlockhash: recentBlockhash.blockhash,
            feePayer: payer.publicKey
        })

        const timestamp = new BN(Date.now())

        // Use different order IDs for both sides of the quote - inconsistent state
        // issues on the program side might happen if we tried to cancel order by ID
        // otherwise.
        const [bidId, askId] = [timestamp.add(new BN(1)), timestamp]

        // ^ When using Time in Force orders, it's important to use *cluster time*
        // as it might drift from actual UNIX time every once and then, effectively
        // being different to what you'd get using Date.now().

        if (blockTime === null) {
            console.log('Failed to fetch block time')

            return
        }

        const expiryTimestamp = new BN(blockTime + 30)

        tx.add(
            makeCancelAllPerpOrdersInstruction(
                mangoGroupConfig.mangoProgramId,
                mangoGroupConfig.publicKey,
                mangoAccount.publicKey,
                payer.publicKey,
                perpMarket.publicKey,
                perpMarket.bids,
                perpMarket.asks,
                new BN(4)
            ),
            makePlacePerpOrder2Instruction(
                mangoGroupConfig.mangoProgramId,
                mangoGroupConfig.publicKey,
                mangoAccount.publicKey,
                payer.publicKey,
                mangoGroup.mangoCache,
                perpMarket.publicKey,
                perpMarket.bids,
                perpMarket.asks,
                perpMarket.eventQueue,
                mangoAccount.getOpenOrdersKeysInBasket(),
                new BN(bidPrice),
                new BN(bidSize),
                I64_MAX_BN,
                bidId,
                'buy',
                new BN(255),
                'postOnlySlide',
                false,
                undefined,
                expiryTimestamp
            ),
            makePlacePerpOrder2Instruction(
                mangoGroupConfig.mangoProgramId,
                mangoGroupConfig.publicKey,
                mangoAccount.publicKey,
                payer.publicKey,
                mangoGroup.mangoCache,
                perpMarket.publicKey,
                perpMarket.bids,
                perpMarket.asks,
                perpMarket.eventQueue,
                mangoAccount.getOpenOrdersKeysInBasket(),
                new BN(askPrice),
                new BN(askSize),
                I64_MAX_BN,
                askId,
                'sell',
                new BN(255),
                'postOnlySlide',
                false,
                undefined,
                 expiryTimestamp
            ),
            riskChecker.makeCheckRiskInstruction(
                perpMarketConfig,
                // @ts-ignore
                perpMarket
            )
        )

        tx.sign(payer)

        const meta = `${tokenPrice} ${[bidPrice.toString(), bidSize.toString()]} ${[askPrice.toString(), askSize.toString()]}`

        try {
            const response = await mangoClient.sendSignedTransaction({
                signedTransaction: tx,
                signedAtBlock: recentBlockhash,
            });

            console.log('quote::response', meta, response);
        } catch (error) {
            console.log('quote::error', meta, error);
        }
    }

    setInterval(quote, 750)
}

async function createSpotOrder2Instruction(
    mangoClient: MangoClient,
    mangoGroup: MangoGroup,
    mangoAccount: MangoAccount,
    spotMarket: Market,
    owner: Payer,

    side: 'buy' | 'sell',
    price: number,
    size: number,
    orderType?: 'limit' | 'ioc' | 'postOnly',
    // @ts-ignore
    clientOrderId?: BN,
    useMsrmVault?: boolean | undefined
) {
    if (!owner.publicKey) {
      return;
    }
    const limitPrice = spotMarket.priceNumberToLots(price);
    const maxBaseQuantity = spotMarket.baseSizeNumberToLots(size);

    // TODO implement srm vault fee discount
    // const feeTier = getFeeTier(0, nativeToUi(mangoGroup.nativeSrm || 0, SRM_DECIMALS));
    const feeTier = getFeeTier(0, nativeToUi(0, 0));
    const rates = getFeeRates(feeTier);
    const maxQuoteQuantity = new BN(
      spotMarket['_decoded'].quoteLotSize.toNumber() * (1 + rates.taker),
    ).mul(
      spotMarket
        .baseSizeNumberToLots(size)
        .mul(spotMarket.priceNumberToLots(price)),
    );

    if (maxBaseQuantity.lte(ZERO_BN)) {
      throw new Error('size too small');
    }
    if (limitPrice.lte(ZERO_BN)) {
      throw new Error('invalid price');
    }
    const selfTradeBehavior = 'decrementTake';

    const spotMarketIndex = mangoGroup.getSpotMarketIndex(spotMarket.publicKey);

    if (!mangoGroup.rootBankAccounts.filter((a) => !!a).length) {
      await mangoGroup.loadRootBanks(mangoClient.connection);
    }
    let feeVault: PublicKey;
    if (useMsrmVault) {
      feeVault = mangoGroup.msrmVault;
    } else if (useMsrmVault === false) {
      feeVault = mangoGroup.srmVault;
    } else {
      const totalMsrm = await mangoClient.connection.getTokenAccountBalance(
        mangoGroup.msrmVault,
      );
      feeVault =
        totalMsrm?.value?.uiAmount && totalMsrm.value.uiAmount > 0
          ? mangoGroup.msrmVault
          : mangoGroup.srmVault;
    }

    const baseRootBank = mangoGroup.rootBankAccounts[spotMarketIndex];
    const baseNodeBank = baseRootBank?.nodeBankAccounts[0];
    const quoteRootBank = mangoGroup.rootBankAccounts[QUOTE_INDEX];
    const quoteNodeBank = quoteRootBank?.nodeBankAccounts[0];

    if (!baseRootBank || !baseNodeBank || !quoteRootBank || !quoteNodeBank) {
      throw new Error('Invalid or missing banks');
    }

    // Only pass in open orders if in margin basket or current market index, and
    // the only writable account should be OpenOrders for current market index

    const openOrdersKeys = zip(mangoAccount.spotOpenOrdersAccounts, range(0, mangoAccount.spotOpenOrdersAccounts.length))
        .filter(([openOrdersAccount, index]) => mangoAccount.inMarginBasket[index!] || index == spotMarketIndex)
        .map(([openOrdersAccount, index]) => (
            {
                pubkey: openOrdersAccount!.publicKey,
                isWritable: index == spotMarketIndex
            }
        ))

    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      spotMarket.programId,
    );

    const placeOrderInstruction = makePlaceSpotOrder2Instruction(
      mangoClient.programId,
      mangoGroup.publicKey,
      mangoAccount.publicKey,
      owner.publicKey,
      mangoGroup.mangoCache,
      spotMarket.programId,
      spotMarket.publicKey,
      spotMarket['_decoded'].bids,
      spotMarket['_decoded'].asks,
      spotMarket['_decoded'].requestQueue,
      spotMarket['_decoded'].eventQueue,
      spotMarket['_decoded'].baseVault,
      spotMarket['_decoded'].quoteVault,
      baseRootBank.publicKey,
      baseNodeBank.publicKey,
      baseNodeBank.vault,
      quoteRootBank.publicKey,
      quoteNodeBank.publicKey,
      quoteNodeBank.vault,
      mangoGroup.signerKey,
      dexSigner,
      feeVault,
      openOrdersKeys,
      side,
      limitPrice,
      maxBaseQuantity,
      maxQuoteQuantity,
      selfTradeBehavior,
      orderType,
      clientOrderId ?? new BN(Date.now()),
    );

    return placeOrderInstruction
  }


main()
