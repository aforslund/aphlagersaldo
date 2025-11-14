import { NextRequest } from 'next/server'
import type {
  StockCheckRequest,
  GoogleFeedProduct,
  AutocompleteResponse,
  ProductStockResult,
  FluentInventoryNode,
} from '@/types'

// Helper functions (copied from stock-check/route.ts)
async function getFluentToken(): Promise<string> {
  const tokenUrl = `${process.env.FLUENT_ENDPOINT?.replace('/graphql', '')}/oauth/token?username=${process.env.FLUENT_USERNAME}&password=${process.env.FLUENT_PASSWORD}&client_id=${process.env.FLUENT_CLIENT_ID}&client_secret=${process.env.FLUENT_CLIENT_SECRET}&grant_type=password&scope=api`

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
  })

  if (!response.ok) {
    throw new Error('Failed to get Fluent token')
  }

  const data = await response.json()
  return data.access_token
}

async function getFluentInventoryForProducts(
  token: string,
  locationRef: string,
  psids: string[],
  onProgress: (message: string) => void
): Promise<Map<string, number>> {
  // Query Fluent for each PSID individually - much faster and more targeted
  const query = `
    query inventoryPositions($locationRefs: [String], $productRefs: [String!]) {
      inventoryPositions(first: 1, locationRef: $locationRefs, productRef: $productRefs) {
        edges {
          node {
            productRef
            onHand
          }
        }
      }
    }`

  const inventoryMap = new Map<string, number>()

  for (let i = 0; i < psids.length; i++) {
    const psid = psids[i]
    onProgress(`Checking Fluent for ${psid} (${i + 1}/${psids.length})...`)

    try {
      const response = await fetch(process.env.FLUENT_ENDPOINT!, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: {
            locationRefs: [locationRef],
            productRefs: [psid],
          },
        }),
      })

      if (!response.ok) {
        console.error(`Fluent API error for ${psid}:`, response.status)
        continue // Skip this item but continue with others
      }

      const data = await response.json()
      if (data.errors) {
        console.error(`Fluent GraphQL errors for ${psid}:`, data.errors)
        continue
      }

      const edges = data.data.inventoryPositions.edges
      if (edges && edges.length > 0) {
        const onHand = edges[0].node.onHand
        inventoryMap.set(psid, onHand)
      }

      // Add delay to avoid DDOS-like behavior (250ms between requests)
      if (i < psids.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    } catch (error) {
      console.error(`Error fetching Fluent inventory for ${psid}:`, error)
      // Continue with next item
    }
  }

  onProgress(`Fluent check complete: found ${inventoryMap.size}/${psids.length} items`)
  return inventoryMap
}

// Helper for NYCE insights
function addNyceInsights(
  details: string[],
  nycePhysical: number,
  nyceOnHand: number,
  nyceInOrder: number,
  nyceUnallocated: number,
  fluentStock: number
) {
  if (nycePhysical > nyceOnHand && nycePhysical - nyceOnHand > 10) {
    details.push(`STAGING BACKLOG: ${nycePhysical - nyceOnHand} units in physical but not onHand (being put away)`)
  }

  // Compare NYCE unallocated with Fluent
  const difference = nyceUnallocated - fluentStock
  if (difference > 10) {
    details.push(`SYNC VARIANCE: NYCE unallocated (${nyceUnallocated}) is ${difference} units higher than Fluent (${fluentStock})`)
    details.push('Possible issue: Check if Fluent is properly receiving stock from NYCE')
  } else if (difference > 0 && difference <= 10) {
    details.push(`MINOR VARIANCE: NYCE unallocated (${nyceUnallocated}) is ${difference} units higher than Fluent (${fluentStock}) - within acceptable range`)
  } else if (difference < 0 && Math.abs(difference) > 10) {
    details.push(`REVERSE VARIANCE: Fluent (${fluentStock}) is ${Math.abs(difference)} units higher than NYCE unallocated (${nyceUnallocated})`)
    details.push('Note: Fluent may have sold items that NYCE has not yet processed')
  }
}

// Full Check analysis
function analyzeStockFull(
  psid: string,
  productName: string,
  productUrl: string | null,
  commerceToolsStock: number,
  fluentStock: number,
  nyceArticle: any
): ProductStockResult {
  const details: string[] = []
  let analysis = ''
  let status: 'ok' | 'issue' | 'warning' = 'issue'

  const nyceOnHand = nyceArticle?.onHandQty || 0
  const nyceInOrder = nyceArticle?.inOrderQty || 0
  const nycePhysical = nyceArticle?.physicalQty || 0
  const nyceUnallocated = nyceOnHand - nyceInOrder  // This is what NYCE sees as totally unallocated

  details.push('Google Feed: NOT SELLABLE (Full Check mode)')

  // Apply the 4-scenario matrix using NYCE unallocated
  if (commerceToolsStock > 0 && fluentStock > 0 && nyceUnallocated > 0) {
    analysis = 'TROLIGTVIS EN SPÄRR (Probably a block)'
    details.push('All systems have stock but Google Feed shows not sellable')
    details.push('This indicates a business logic block/restriction (affärslogik spärr)')
    details.push('Action: Check business rules and restrictions in Google Feed logic')
  }
  else if (commerceToolsStock === 0 && fluentStock > 0 && nyceUnallocated > 0) {
    analysis = 'TROLIGTVIS SYNKPROBLEM (Probably sync problem)'
    details.push(`CommerceTools shows 0 but Fluent has ${fluentStock} and NYCE unallocated has ${nyceUnallocated}`)
    details.push('CommerceTools should mirror Fluent with some delay')
    details.push('Action: Check CommerceTools sync process with Fluent')
  }
  else if (commerceToolsStock === 0 && fluentStock === 0 && nyceUnallocated > 0) {
    analysis = 'LAGERSYNKPROBLEM ELLER UTSÅLT (Inventory sync problem or sold out)'
    details.push(`NYCE has ${nyceUnallocated} unallocated units but Fluent shows 0`)
    details.push('Either stock sync issue from NYCE to Fluent or items not digitally sellable')
    details.push('Action: Check if stock is available for digital sales in NYCE')
  }
  else if (commerceToolsStock === 0 && fluentStock === 0 && nyceUnallocated === 0) {
    analysis = 'EJ INLEVERAT - DATA OK (Not delivered - data consistent)'
    status = 'ok'  // This is actually OK - all systems agree there's no stock
    details.push('All systems correctly show 0 stock')
    details.push('Product may not have been delivered to warehouse yet, but data is consistent')
    details.push('Note: Purchasing should verify if delivery is expected')
  }
  else {
    analysis = 'INVESTIGATE - Stock pattern not matching standard scenarios'
    details.push(`CT: ${commerceToolsStock}, Fluent: ${fluentStock}, NYCE unallocated: ${nyceUnallocated}`)
  }

  // Check if Fluent and NYCE are in sync (within acceptable variance)
  const syncDiff = nyceUnallocated - fluentStock
  if (syncDiff > 0 && syncDiff <= 10) {
    status = 'warning'  // Orange - minor acceptable variance
  } else if (syncDiff > 10) {
    status = 'issue'  // Red - significant variance
  }

  if (nyceArticle) {
    addNyceInsights(details, nycePhysical, nyceOnHand, nyceInOrder, nyceUnallocated, fluentStock)
  }

  return {
    psid,
    productName,
    productUrl,
    googleSellable: false,
    commerceToolsStock,
    fluentStock,
    nyceStock: nyceArticle,
    status,
    analysis,
    details,
  }
}

// Spot-check analysis
function analyzeStockSpot(
  psid: string,
  productName: string,
  productUrl: string | null,
  commerceToolsStock: number,
  fluentStock: number
): ProductStockResult {
  const details: string[] = []
  let analysis = ''
  let status: 'ok' | 'issue' = 'ok'

  details.push('Spot-check mode: Autocomplete (CommerceTools) and Fluent only')

  if (commerceToolsStock > 0 && fluentStock > 0) {
    const difference = Math.abs(commerceToolsStock - fluentStock)
    if (difference === 0) {
      analysis = 'PERFECTLY SYNCED - CT and Fluent match exactly'
    } else if (difference <= 5) {
      analysis = 'IN SYNC - CT and Fluent closely aligned'
      details.push(`Minor difference: ${difference} units`)
    } else {
      analysis = 'SYNC VARIANCE - CT and Fluent have different stock levels'
      status = 'issue'
      details.push(`Difference: ${difference} units (CT: ${commerceToolsStock}, Fluent: ${fluentStock})`)
      details.push('Note: Fluent is typically ahead as it releases to downstream systems with delay')
    }
  } else if (commerceToolsStock === 0 && fluentStock > 0) {
    analysis = 'SYNC ISSUE - CommerceTools not updated'
    status = 'issue'
    details.push(`Fluent has ${fluentStock} units but CommerceTools shows 0`)
    details.push('Action: Check CommerceTools sync process with Fluent')
  } else if (commerceToolsStock > 0 && fluentStock === 0) {
    analysis = 'UNEXPECTED - CT has stock but Fluent shows 0'
    status = 'issue'
    details.push(`CommerceTools shows ${commerceToolsStock} but Fluent has 0`)
    details.push('This is unusual - Fluent should be ahead. Investigate data flow.')
  } else {
    analysis = 'NO STOCK - Both systems show 0'
    details.push('Item is out of stock in both CommerceTools and Fluent')
  }

  return {
    psid,
    productName,
    productUrl,
    googleSellable: null,
    commerceToolsStock,
    fluentStock,
    nyceStock: null,
    status,
    analysis,
    details,
  }
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (type: string, data: any) => {
        const message = `data: ${JSON.stringify({ type, ...data })}\n\n`
        controller.enqueue(encoder.encode(message))
      }

      try {
        const body: StockCheckRequest = await request.json()
        const { psids, checkMode, nyceCsvData } = body

        console.log('Stream request:', { checkMode, psidsCount: psids?.length, hasNyceData: !!nyceCsvData })

        // Validation
        if (!psids || !Array.isArray(psids)) {
          sendEvent('error', { message: 'Invalid PSIDs provided' })
          controller.close()
          return
        }

        if (checkMode === 'full' && !nyceCsvData) {
          sendEvent('error', { message: 'Full Check requires NYCE CSV data' })
          controller.close()
          return
        }

        sendEvent('progress', { message: `Starting ${checkMode} check for ${psids.length} items...`, current: 0, total: psids.length })

        const results: ProductStockResult[] = []
        const errors: string[] = []

        // FULL CHECK MODE
        if (checkMode === 'full') {
          sendEvent('progress', { message: 'Fetching Google Feed...', current: 0, total: 1 })

          // 1. Fetch Google Feed
          const googleFeedUrl = process.env.NEXT_PUBLIC_GOOGLE_FEED_URL
          console.log('Fetching Google Feed from:', googleFeedUrl)

          if (!googleFeedUrl) {
            const error = 'NEXT_PUBLIC_GOOGLE_FEED_URL is not configured'
            console.error(error)
            sendEvent('error', { message: error })
            throw new Error(error)
          }

          let googleProducts: GoogleFeedProduct[]
          try {
            const googleFeedResponse = await fetch(googleFeedUrl, {
              signal: AbortSignal.timeout(30000) // 30 second timeout
            })
            if (!googleFeedResponse.ok) {
              throw new Error(`Google Feed returned status ${googleFeedResponse.status}`)
            }

            // Get the raw text first to better debug JSON parsing errors
            const rawText = await googleFeedResponse.text()
            try {
              googleProducts = JSON.parse(rawText)
              console.log('Google Feed loaded:', googleProducts.length, 'products')
            } catch (jsonError) {
              console.error('Google Feed JSON parsing failed. First 200 chars:', rawText.substring(0, 200))
              throw new Error(`Google Feed returned invalid JSON: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`)
            }
          } catch (error) {
            const errorMsg = `Failed to fetch Google Feed: ${error instanceof Error ? error.message : String(error)}`
            console.error(errorMsg, error)
            sendEvent('error', { message: errorMsg })
            sendEvent('error', { message: `Google Feed URL: ${googleFeedUrl}` })
            throw new Error(errorMsg)
          }

          sendEvent('progress', { message: `Google Feed loaded: ${googleProducts.length} total products`, current: 0, total: 1 })

          // 2. Filter to items that are NOT sellable (out of stock)
          const notSellableProducts = googleProducts.filter(p => p.Availability === 'out_of_stock')
          const notSellablePsids = notSellableProducts.map(p => p.Id)

          // Create a map for easy lookup of product details
          const googleProductMap = new Map<string, GoogleFeedProduct>()
          googleProducts.forEach(p => googleProductMap.set(p.Id, p))

          console.log('Not sellable products:', notSellablePsids.length, 'items')

          sendEvent('progress', { message: `Found ${notSellableProducts.length} not-sellable items in Google Feed`, current: 0, total: notSellableProducts.length })

          if (notSellableProducts.length === 0) {
            sendEvent('progress', { message: 'No out-of-stock items found in Google Feed. Nothing to check!', current: 0, total: 0 })
            sendEvent('complete', { results: [], errors: [], total: 0 })
            controller.close()
            return
          }

          // 3. Process NYCE CSV data
          const nyceDataMap = new Map<string, any>()
          Object.keys(nyceCsvData!).forEach(sku => {
            nyceDataMap.set(sku, {
              articleId: sku,
              onHandQty: nyceCsvData![sku].balance,
              inOrderQty: nyceCsvData![sku].inOrder,
              physicalQty: nyceCsvData![sku].balance,
              stoppedQty: 0,
              allocatedQty: 0,
            })
          })

          sendEvent('progress', { message: `NYCE data loaded: ${nyceDataMap.size} items from CSV`, current: 0, total: notSellableProducts.length })

          // 4. Get Fluent token
          sendEvent('progress', { message: 'Getting Fluent authentication...', current: 0, total: notSellableProducts.length })
          console.log('Attempting to get Fluent token...')

          let fluentToken: string
          try {
            fluentToken = await getFluentToken()
            console.log('Fluent token acquired successfully')
            sendEvent('progress', { message: 'Fluent authentication successful', current: 0, total: notSellableProducts.length })
          } catch (error) {
            const errorMsg = `Fluent authentication failed: ${error instanceof Error ? error.message : String(error)}`
            console.error(errorMsg, error)
            sendEvent('error', { message: errorMsg })
            sendEvent('error', { message: 'Check FLUENT_ENDPOINT, FLUENT_USERNAME, FLUENT_PASSWORD, FLUENT_CLIENT_ID, FLUENT_CLIENT_SECRET environment variables' })
            throw new Error(errorMsg)
          }

          // 5. For each not-sellable item, check if it's in NYCE CSV and process it
          let processedCount = 0
          let skippedCount = 0
          let itemsWithUnallocatedStock = 0

          // Count how many out-of-stock items are actually in the NYCE CSV
          const itemsToProcess = notSellablePsids.filter(psid => nyceDataMap.has(psid))
          console.log(`Out of ${notSellablePsids.length} not-sellable items, ${itemsToProcess.length} are in NYCE CSV`)
          sendEvent('progress', {
            message: `Processing ${itemsToProcess.length} items that are both out-of-stock AND in NYCE...`,
            current: 0,
            total: notSellablePsids.length
          })

          if (itemsToProcess.length === 0) {
            sendEvent('progress', { message: 'No out-of-stock items found in NYCE CSV. Check complete.', current: 0, total: 0 })
            sendEvent('complete', {
              results: [],
              errors: [],
              total: 0,
              summary: {
                totalGoogleFeedItems: googleProducts.length,
                notSellableCount: notSellablePsids.length,
                nyceCsvCount: nyceDataMap.size,
                overlapCount: 0,
                itemsWithUnallocatedStock: 0
              }
            })
            controller.close()
            return
          }

          for (let i = 0; i < notSellablePsids.length; i++) {
            const psid = notSellablePsids[i]

            // Check if this PSID exists in NYCE CSV
            if (!nyceDataMap.has(psid)) {
              skippedCount++
              sendEvent('progress', {
                message: `${psid} not in NYCE CSV - skipping (${i + 1}/${notSellablePsids.length})`,
                current: i + 1,
                total: notSellablePsids.length
              })
              continue
            }

            processedCount++
            sendEvent('progress', {
              message: `Checking ${psid} - NOT sellable (${i + 1}/${notSellablePsids.length})...`,
              current: i + 1,
              total: notSellablePsids.length
            })

            try {
              // Get Fluent inventory for this specific PSID
              const fluentResponse = await fetch(process.env.FLUENT_ENDPOINT!, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${fluentToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  query: `query inventoryPositions($locationRefs: [String], $productRefs: [String!]) {
                    inventoryPositions(first: 1, locationRef: $locationRefs, productRef: $productRefs) {
                      edges { node { productRef onHand } }
                    }
                  }`,
                  variables: {
                    locationRefs: [process.env.FLUENT_LOCATION_REF],
                    productRefs: [psid],
                  },
                }),
              })

              const fluentData = await fluentResponse.json()
              const fluentStock = fluentData.data?.inventoryPositions?.edges?.[0]?.node?.onHand || 0

              // Get autocomplete data
              const autocompleteUrl = `${process.env.NEXT_PUBLIC_AUTOCOMPLETE_URL}?language=sv-SE&q=${psid}`
              let autocompleteData: AutocompleteResponse | null = null
              let matchedProduct: any = null
              let commerceToolsStock = 0

              try {
                const autocompleteResponse = await fetch(autocompleteUrl)
                if (!autocompleteResponse.ok) {
                  throw new Error(`Autocomplete API returned status ${autocompleteResponse.status}`)
                }
                const rawText = await autocompleteResponse.text()
                try {
                  autocompleteData = JSON.parse(rawText)
                } catch (jsonError) {
                  console.error(`Autocomplete JSON parsing failed for ${psid}. First 200 chars:`, rawText.substring(0, 200))
                  throw new Error(`Autocomplete returned invalid JSON for ${psid}: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`)
                }

                matchedProduct = autocompleteData.products.find(p => p.variant && p.variant.sku === psid)
                commerceToolsStock = matchedProduct?.variant?.inventoryQuantity || 0
              } catch (error) {
                console.error(`Autocomplete error for ${psid}:`, error)
                sendEvent('error', { message: `Autocomplete API failed for ${psid}: ${error instanceof Error ? error.message : String(error)}` })
                // Continue processing with 0 stock
              }

              // Get product details from Google Feed
              const googleProduct = googleProductMap.get(psid)
              const productName = googleProduct?.Title || matchedProduct?.productName || 'Unknown Product'
              const productUrl = googleProduct?.Link || matchedProduct?.url || null

              const nyceArticle = nyceDataMap.get(psid) || null

              // Count items with unallocated stock
              if (nyceArticle) {
                const nyceUnallocated = nyceArticle.onHandQty - nyceArticle.inOrderQty
                if (nyceUnallocated > 0) {
                  itemsWithUnallocatedStock++
                }
              }

              // Analyze using Full Check logic (from stock-check/route.ts)
              const result = analyzeStockFull(psid, productName, productUrl, commerceToolsStock, fluentStock, nyceArticle)
              results.push(result)
              sendEvent('result', { result })

              // Small delay
              if (i < psids.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 250))
              }
            } catch (error) {
              const errorMsg = `Failed to process PSID ${psid}: ${error}`
              errors.push(errorMsg)
              sendEvent('error', { message: errorMsg })
            }
          }

          sendEvent('progress', {
            message: `Full Check complete: ${notSellablePsids.length} not-sellable in Google Feed, ${processedCount} checked (${skippedCount} not in NYCE CSV)`,
            current: notSellablePsids.length,
            total: notSellablePsids.length
          })

          // Send summary statistics for Full Check mode
          sendEvent('summary', {
            totalGoogleFeedItems: googleProducts.length,
            notSellableCount: notSellablePsids.length,
            nyceCsvCount: nyceDataMap.size,
            overlapCount: itemsToProcess.length,
            itemsWithUnallocatedStock: itemsWithUnallocatedStock
          })
        }
        // SPOT-CHECK MODE
        else if (checkMode === 'spot') {
          // Get Fluent token
          sendEvent('progress', { message: 'Getting Fluent authentication token...', current: 0, total: psids.length })
          const fluentToken = await getFluentToken()

          // Get Fluent inventory
          sendEvent('progress', { message: 'Fetching Fluent inventory...', current: 0, total: psids.length })
          const fluentMap = await getFluentInventoryForProducts(
            fluentToken,
            process.env.FLUENT_LOCATION_REF!,
            psids,
            (message) => sendEvent('progress', { message, current: 0, total: psids.length })
          )

          // Process each PSID
          for (let i = 0; i < psids.length; i++) {
            const psid = psids[i]
            sendEvent('progress', {
              message: `Checking ${psid} (${i + 1}/${psids.length})...`,
              current: i + 1,
              total: psids.length
            })

            try {
              const autocompleteUrl = `${process.env.NEXT_PUBLIC_AUTOCOMPLETE_URL}?language=sv-SE&q=${psid}`
              const autocompleteResponse = await fetch(autocompleteUrl)
              const autocompleteData: AutocompleteResponse = await autocompleteResponse.json()

              const matchedProduct = autocompleteData.products.find(
                p => p.variant && p.variant.sku === psid
              )

              const productName = matchedProduct?.productName || 'Unknown Product'
              const productUrl = matchedProduct?.url || null
              const commerceToolsStock = matchedProduct?.variant?.inventoryQuantity || 0
              const fluentStock = fluentMap.get(psid) || 0

              const result = analyzeStockSpot(psid, productName, productUrl, commerceToolsStock, fluentStock)
              results.push(result)

              sendEvent('result', { result })
            } catch (error) {
              const errorMsg = `Failed to process PSID ${psid}`
              errors.push(errorMsg)
              sendEvent('error', { message: errorMsg })
            }
          }
        }

        // Send completion
        sendEvent('complete', { results, errors, total: results.length })
        controller.close()

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        console.error('Fatal error in stock check:', errorMessage, error)
        sendEvent('error', { message: `Fatal error: ${errorMessage}` })

        // Provide helpful debugging info
        if (errorMessage.includes('network') || errorMessage.includes('fetch')) {
          sendEvent('error', { message: 'Network error - check that all API endpoints are accessible and environment variables are correctly set' })
        }

        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
