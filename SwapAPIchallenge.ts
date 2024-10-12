// Script for integrating with Scroll and the 0x API to perform token swaps
// It covers: liquidity sources, fees, and token tax handling
// Additionally, handles Permit2 for token approvals and submitting on-chain txs

/* For the 0x Challenge on Scroll, the objectives are:

1. Show percentage breakdown of liquidity sources
2. Monetize app through affiliate fees and surplus collection
3. Display buy/sell tax for taxed tokens
4. List all liquidity sources on the Scroll network

*/
import { config as dotenv } from "dotenv";
import {
  createWalletClient,
  http,
  getContract,
  erc20Abi,
  parseUnits,
  maxUint256,
  publicActions,
  concat,
  numberToHex,
  size,
} from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { scroll } from "viem/chains";
import { wethAbi } from "./abi/weth-abi";

const qs = require("qs");

// Load environment variables from .env file
dotenv();
const { PRIVATE_KEY, ZERO_EX_API_KEY, ALCHEMY_HTTP_TRANSPORT_URL } = process.env;

// Check if required environment variables are available
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY.");
if (!ZERO_EX_API_KEY) throw new Error("Missing ZERO_EX_API_KEY.");
if (!ALCHEMY_HTTP_TRANSPORT_URL) throw new Error("Missing ALCHEMY_HTTP_TRANSPORT_URL.");

// Set up HTTP headers for the 0x API
const headers = new Headers({
  "Content-Type": "application/json",
  "0x-api-key": ZERO_EX_API_KEY,
  "0x-version": "v2",
});

// Initialize the wallet client
const client = createWalletClient({
  account: privateKeyToAccount(`0x${PRIVATE_KEY}` as `0x${string}`),
  chain: scroll,
  transport: http(ALCHEMY_HTTP_TRANSPORT_URL),
}).extend(publicActions); // Add public client actions to the wallet client

const [address] = await client.getAddresses();

// Set up contract instances for WETH and wstETH
const weth = getContract({
  address: "0x5300000000000000000000000000000000000004",
  abi: wethAbi,
  client,
});

const wsteth = getContract({
  address: "0xf610A9dfB7C89644979b4A0f27063E9e7d7Cda32",
  abi: erc20Abi,
  client,
});

// Function to display the liquidity sources' percentage breakdown
function displayLiquiditySources(route: any) {
  const fills = route.fills;
  const totalBps = fills.reduce((acc: number, fill: any) => acc + parseInt(fill.proportionBps), 0);

  console.log(`${fills.length} liquidity sources:`);
  fills.forEach((fill: any) => {
    const percentage = (parseInt(fill.proportionBps) / 100).toFixed(2);
    console.log(`${fill.source}: ${percentage}%`);
  });
}

// Function to display buy/sell taxes for tokens
function displayTokenTaxes(tokenMetadata: any) {
  const buyTokenBuyTax = (parseInt(tokenMetadata.buyToken.buyTaxBps) / 100).toFixed(2);
  const buyTokenSellTax = (parseInt(tokenMetadata.buyToken.sellTaxBps) / 100).toFixed(2);
  const sellTokenBuyTax = (parseInt(tokenMetadata.sellToken.buyTaxBps) / 100).toFixed(2);
  const sellTokenSellTax = (parseInt(tokenMetadata.sellToken.sellTaxBps) / 100).toFixed(2);

  if (buyTokenBuyTax > 0 || buyTokenSellTax > 0) {
    console.log(`Buy Token Taxes -> Buy: ${buyTokenBuyTax}%, Sell: ${buyTokenSellTax}%`);
  }

  if (sellTokenBuyTax > 0 || sellTokenSellTax > 0) {
    console.log(`Sell Token Taxes -> Buy: ${sellTokenBuyTax}%, Sell: ${sellTokenSellTax}%`);
  }
}

// Function to retrieve all liquidity sources from the 0x API for the Scroll chain
const getLiquiditySources = async () => {
  const chainId = client.chain.id.toString();
  const sourcesParams = new URLSearchParams({ chainId });

  const sourcesResponse = await fetch(
    `https://api.0x.org/swap/v1/sources?${sourcesParams.toString()}`,
    { headers }
  );

  const sourcesData = await sourcesResponse.json();
  const sources = Object.keys(sourcesData.sources);
  console.log("Available liquidity sources on Scroll:");
  console.log(sources.join(", "));
};

const main = async () => {
  // Retrieve and display liquidity sources on Scroll
  await getLiquiditySources();

  // Set the sell amount for swapping (e.g., 0.1 WETH)
  const decimals = (await weth.read.decimals()) as number;
  const sellAmount = parseUnits("0.1", decimals);

  // Parameters for monetization (e.g., affiliate fees)
  const affiliateFeeBps = "100"; // 1% affiliate fee
  const surplusCollection = "true";

  // Fetch price quote with monetization parameters
  const priceParams = new URLSearchParams({
    chainId: client.chain.id.toString(),
    sellToken: weth.address,
    buyToken: wsteth.address,
    sellAmount: sellAmount.toString(),
    taker: client.account.address,
    affiliateFee: affiliateFeeBps,
    surplusCollection,
  });

  const priceResponse = await fetch(
    "https://api.0x.org/swap/permit2/price?" + priceParams.toString(),
    { headers }
  );

  const price = await priceResponse.json();
  console.log(`Price to swap 0.1 WETH for wstETH: ${price}`);

  // Check if Permit2 allowance needs to be set
  if (price.issues.allowance !== null) {
    try {
      const { request } = await weth.simulate.approve([
        price.issues.allowance.spender,
        maxUint256,
      ]);
      console.log("Approving Permit2...");
      const hash = await weth.write.approve(request.args);
      console.log("Permit2 approved, transaction hash:", hash);
    } catch (error) {
      console.error("Error approving Permit2:", error);
    }
  } else {
    console.log("Permit2 already has the required approval.");
  }

  // Fetch quote for the token swap
  const quoteParams = new URLSearchParams(priceParams);
  const quoteResponse = await fetch(
    "https://api.0x.org/swap/permit2/quote?" + quoteParams.toString(),
    { headers }
  );

  const quote = await quoteResponse.json();
  console.log(`Quote for swapping 0.1 WETH for wstETH:`, quote);

  // Display liquidity sources breakdown from the quote
  if (quote.route) displayLiquiditySources(quote.route);

  // Show token taxes, if available
  if (quote.tokenMetadata) displayTokenTaxes(quote.tokenMetadata);

  // Monetization details (affiliate fee and surplus)
  if (quote.affiliateFeeBps) {
    const affiliateFee = (parseInt(quote.affiliateFeeBps) / 100).toFixed(2);
    console.log(`Affiliate Fee: ${affiliateFee}%`);
  }
  if (quote.tradeSurplus && parseFloat(quote.tradeSurplus) > 0) {
    console.log(`Trade Surplus Collected: ${quote.tradeSurplus}`);
  }

  // Sign permit2 message for the transaction
  let signature: Hex | undefined;
  if (quote.permit2?.eip712) {
    try {
      signature = await client.signTypedData(quote.permit2.eip712);
      console.log("Permit2 signed successfully.");
    } catch (error) {
      console.error("Error signing Permit2 message:", error);
    }

    // Append signature to transaction data
    if (signature && quote?.transaction?.data) {
      const signatureLengthInHex = numberToHex(size(signature), {
        signed: false,
        size: 32,
      });

      const transactionData = quote.transaction.data as Hex;
      const sigLengthHex = signatureLengthInHex as Hex;
      const sig = signature as Hex;

      quote.transaction.data = concat([transactionData, sigLengthHex, sig]);
    } else {
      throw new Error("Failed to obtain signature or transaction data");
    }
  }

  // Submit the signed transaction
  if (signature && quote.transaction.data) {
    const nonce = await client.getTransactionCount({
      address: client.account.address,
    });

    const signedTransaction = await client.signTransaction({
      account: client.account,
      chain: client.chain,
      gas: quote?.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
      to: quote?.transaction.to,
      data: quote.transaction.data,
      value: quote?.transaction.value ? BigInt(quote.transaction.value) : undefined,
      gasPrice: quote?.transaction.gasPrice ? BigInt(quote.transaction.gasPrice) : undefined,
      nonce,
    });

    const hash = await client.sendRawTransaction({
      serializedTransaction: signedTransaction,
    });

    console.log("Transaction sent, hash:", hash);
    console.log(`View transaction at https://scrollscan.com/tx/${hash}`);
  } else {
    console.error("Transaction not sent, signature or data missing.");
  }
};

main();
