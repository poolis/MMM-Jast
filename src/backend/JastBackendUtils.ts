import * as Log from 'logger'
import * as yahooFinance2Module from 'yahoo-finance2'
import type { Quote } from 'yahoo-finance2/esm/src/modules/quote'
import type { QuoteSummaryResult } from 'yahoo-finance2/esm/src/modules/quoteSummary'
import { Config } from '../types/Config'
import { StockResponse } from '../types/StockResponse'

// Handle both ESM and CommonJS module formats
// TypeScript sees the namespace import, but at runtime Rollup will provide the correct format
const YahooFinance = ('default' in yahooFinance2Module
  ? yahooFinance2Module.default
  : yahooFinance2Module) as unknown as new (options: { suppressNotices: string[] }) => {
  quote: (symbol: string) => Promise<Quote>
  quoteSummary: (symbol: string, options: { modules: string[] }) => Promise<QuoteSummaryResult>
}

let yahooFinanceClient:
  | {
      quote: (symbol: string) => Promise<Quote>
      quoteSummary: (symbol: string, options: { modules: string[] }) => Promise<QuoteSummaryResult>
    }
  | undefined

const getYahooFinanceClient = (): {
  quote: (symbol: string) => Promise<Quote>
  quoteSummary: (symbol: string, options: { modules: string[] }) => Promise<QuoteSummaryResult>
} => {
  if (!yahooFinanceClient) {
    yahooFinanceClient = new YahooFinance({ suppressNotices: ['yahooSurvey'] })
  }

  return yahooFinanceClient
}

const MAX_REQUEST_ATTEMPTS = 2
const RETRY_DELAY_MS = 750
const MAX_CONCURRENT_REQUESTS = 2
const DIRECT_QUOTE_TIMEOUT_MS = 10000

interface DirectQuoteApiResponse {
  quoteResponse?: {
    result?: {
      symbol?: string
      currency?: string
      longName?: string
      shortName?: string
      regularMarketPrice?: number
      regularMarketChange?: number
      regularMarketChangePercent?: number
      regularMarketPreviousClose?: number
      regularMarketTime?: number
    }[]
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const getErrorCauseCode = (error: Error): string => {
  const cause = (error as Error & { cause?: { code?: unknown } }).cause

  return typeof cause?.code === 'string' ? cause.code : ''
}

const getErrorCauseMessage = (error: Error): string => {
  const cause = (error as Error & { cause?: { message?: unknown } }).cause

  return typeof cause?.message === 'string' ? cause.message : ''
}

const isRetryableRequestError = (error: Error): boolean => {
  const code = getErrorCauseCode(error)
  const message = error.message.toLowerCase()

  if (
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
      'ENOTFOUND',
      'EAI_AGAIN'
    ].includes(code)
  ) {
    return true
  }

  return (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('socket') ||
    message.includes('timed out')
  )
}

const quoteSummaryWithRetry = async (
  yahooFinance: {
    quote: (symbol: string) => Promise<Quote>
    quoteSummary: (symbol: string, options: { modules: string[] }) => Promise<QuoteSummaryResult>
  },
  symbol: string
): Promise<QuoteSummaryResult> => {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await yahooFinance.quoteSummary(symbol, { modules: ['price'] })
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error
      }

      lastError = error

      if (!isRetryableRequestError(error) || attempt >= MAX_REQUEST_ATTEMPTS) {
        throw error
      }

      Log.warn(
        `Transient API request issue for ${symbol}, retrying: ${error.message}`,
        getErrorCauseCode(error),
        getErrorCauseMessage(error)
      )

      await sleep(RETRY_DELAY_MS * attempt)
    }
  }

  throw lastError ?? new Error(`API request for ${symbol} failed without a captured error.`)
}

const quoteWithRetry = async (
  yahooFinance: {
    quote: (symbol: string) => Promise<Quote>
    quoteSummary: (symbol: string, options: { modules: string[] }) => Promise<QuoteSummaryResult>
  },
  symbol: string
): Promise<Quote> => {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await yahooFinance.quote(symbol)
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error
      }

      lastError = error

      if (!isRetryableRequestError(error) || attempt >= MAX_REQUEST_ATTEMPTS) {
        throw error
      }

      await sleep(RETRY_DELAY_MS * attempt)
    }
  }

  throw lastError ?? new Error(`Fallback quote request for ${symbol} failed without a captured error.`)
}

const directQuoteRequest = async (symbol: string): Promise<QuoteSummaryResult> => {
  const endpoint = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(DIRECT_QUOTE_TIMEOUT_MS),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'MMM-Jast/2.x'
    }
  })

  if (!response.ok) {
    throw new Error(`Direct quote request for ${symbol} failed with status ${response.status}.`)
  }

  const payload = (await response.json()) as DirectQuoteApiResponse
  const quote = payload.quoteResponse?.result?.[0]

  if (!quote || typeof quote.regularMarketPrice !== 'number' || !quote.currency) {
    throw new Error(`Direct quote response for ${symbol} did not include required market fields.`)
  }

  return {
    price: {
      symbol: quote.symbol ?? symbol,
      currency: quote.currency,
      longName: quote.longName ?? quote.shortName,
      regularMarketPrice: quote.regularMarketPrice,
      regularMarketChange: quote.regularMarketChange,
      regularMarketChangePercent: quote.regularMarketChangePercent,
      regularMarketPreviousClose: quote.regularMarketPreviousClose,
      regularMarketTime:
        typeof quote.regularMarketTime === 'number' ? new Date(quote.regularMarketTime * 1000).toISOString() : undefined
    }
  } as QuoteSummaryResult
}

const directQuoteWithRetry = async (symbol: string): Promise<QuoteSummaryResult> => {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await directQuoteRequest(symbol)
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error
      }

      lastError = error

      if (!isRetryableRequestError(error) || attempt >= MAX_REQUEST_ATTEMPTS) {
        throw error
      }

      await sleep(RETRY_DELAY_MS * attempt)
    }
  }

  throw lastError ?? new Error(`Direct quote fallback for ${symbol} failed without a captured error.`)
}

const mapQuoteToQuoteSummary = (quote: Quote): QuoteSummaryResult =>
  ({
    price: {
      symbol: quote.symbol,
      currency: quote.currency,
      longName: quote.longName ?? quote.shortName,
      regularMarketPrice: quote.regularMarketPrice,
      regularMarketChange: quote.regularMarketChange,
      regularMarketChangePercent: quote.regularMarketChangePercent,
      regularMarketPreviousClose: quote.regularMarketPreviousClose,
      regularMarketTime: quote.regularMarketTime
    }
  }) as QuoteSummaryResult

const getQuoteDataWithFallback = async (
  yahooFinance: {
    quote: (symbol: string) => Promise<Quote>
    quoteSummary: (symbol: string, options: { modules: string[] }) => Promise<QuoteSummaryResult>
  },
  symbol: string
): Promise<QuoteSummaryResult> => {
  try {
    return await quoteSummaryWithRetry(yahooFinance, symbol)
  } catch (summaryError) {
    if (!(summaryError instanceof Error)) {
      throw summaryError
    }

    Log.warn(
      `quoteSummary failed for ${symbol}, trying direct quote API fallback: ${summaryError.message}`,
      getErrorCauseCode(summaryError),
      getErrorCauseMessage(summaryError)
    )

    try {
      return await directQuoteWithRetry(symbol)
    } catch (directError) {
      if (!(directError instanceof Error)) {
        throw directError
      }

      Log.warn(
        `Direct quote API fallback failed for ${symbol}, trying yahoo-finance quote fallback: ${directError.message}`,
        getErrorCauseCode(directError),
        getErrorCauseMessage(directError)
      )
    }

    try {
      const quote = await quoteWithRetry(yahooFinance, symbol)

      return mapQuoteToQuoteSummary(quote)
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error
      }

      Log.warn(
        `quote fallback failed for ${symbol} after quoteSummary/direct failures: ${error.message}`,
        getErrorCauseCode(error),
        getErrorCauseMessage(error)
      )

      throw error
    }
  }
}

const requestStocksWithConcurrencyLimit = async (
  yahooFinance: {
    quote: (symbol: string) => Promise<Quote>
    quoteSummary: (symbol: string, options: { modules: string[] }) => Promise<QuoteSummaryResult>
  },
  symbols: string[]
): Promise<(QuoteSummaryResult | Error)[]> => {
  const responses: (QuoteSummaryResult | Error)[] = Array.from({ length: symbols.length })
  let nextIndex = 0

  const runWorker = async (): Promise<void> => {
    while (nextIndex < symbols.length) {
      const currentIndex = nextIndex
      nextIndex += 1

      try {
        responses[currentIndex] = await getQuoteDataWithFallback(yahooFinance, symbols[currentIndex])
      } catch (error) {
        responses[currentIndex] = error instanceof Error ? error : new Error(String(error))
      }
    }
  }

  const workerCount = Math.max(1, Math.min(MAX_CONCURRENT_REQUESTS, symbols.length))
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

  return responses
}

const JastBackendUtils = {
  async requestStocks(config: Config): Promise<StockResponse[]> {
    const yahooFinance = getYahooFinanceClient()
    const stocks = []
    const symbols = config.stocks.map((stock) => stock.symbol)
    const apiResponses = await requestStocksWithConcurrencyLimit(yahooFinance, symbols)

    for (const [index, response] of apiResponses.entries()) {
      if (response instanceof Error) {
        Log.warn(
          `API request for ${config.stocks[index].symbol} failed:`,
          response.message,
          getErrorCauseCode(response),
          getErrorCauseMessage(response)
        )
      } else if (response.price) {
        const meta = {
          symbol: config.stocks[index].symbol,
          name: config.stocks[index].name,
          quantity: config.stocks[index].quantity,
          hidden: config.stocks[index].hidden,
          purchasePrice: config.stocks[index].purchasePrice
        }
        // Manually convert GBp to GBP
        if (response.price.currency === 'GBp') {
          if (typeof response.price.regularMarketPrice === 'number') {
            response.price.regularMarketPrice /= 100
          }
          if (typeof response.price.regularMarketChange === 'number') {
            response.price.regularMarketChange /= 100
          }
          response.price.currency = 'GBP'
        }

        // Override changes if they are older than maxChangeAge
        if (config.maxChangeAge > 0) {
          const maxChangeAge = new Date().getTime() - config.maxChangeAge
          try {
            const marketTime = response.price.regularMarketTime
            const lastChange =
              marketTime instanceof Date
                ? marketTime.getTime()
                : typeof marketTime === 'string'
                  ? Date.parse(marketTime)
                  : Number.NaN

            if (maxChangeAge > lastChange) {
              response.price.regularMarketPreviousClose = response.price?.regularMarketPrice
              response.price.regularMarketChange = 0
              response.price.regularMarketChangePercent = 0
            }
          } catch (err) {
            Log.warn('Could not parse lastChange date', err)
          }
        }

        stocks.push({ price: response.price, meta })
      } else {
        Log.warn(`Response for ${config.stocks[index].symbol} does not satisfy expected payload.`)
      }
    }

    return stocks
  }
}

export default JastBackendUtils
