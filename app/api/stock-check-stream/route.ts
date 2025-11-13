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
  nyceStoppedQty: number,
  nyceAvailable: number,
  fluentStock: number
) {
  if (nycePhysical > nyceOnHand && nycePhysical - nyceOnHand > 10) {
    details.push(`STAGING BACKLOG: ${nycePhysical - nyceOnHand} units in physical but not onHand (being put away)`)
  }

  if (nyceStoppedQty > 0) {
    details.push(`STOPPED STOCK: ${nyceStoppedQty} units stopped (possibly moved to inspection)`)
  }

  if (nyceInOrder < 5 && nyceStoppedQty > 20) {
    details.push(`POSSIBLE INSPECTION: Low inOrder (${nyceInOrder}) but high stopped qty (${nyceStoppedQty})`)
  }

  const difference = Math.abs(nyceAvailable - fluentStock)
  if (difference > 5) {
    details.push(`SYNC VARIANCE: NYCE available (${nyceAvailable}) vs Fluent (${fluentStock}) - difference of ${difference} units`)
    details.push('Note: Fluent is typically ahead as it releases to NYCE only when ready for picking')
  }
}

// Full Check analysis
function analyzeStockFull(
  psid: string,
  productName: string,
  commerceToolsStock: number,
  fluentStock: number,
  nyceArticle: any
): ProductStockResult {
  const details: string[] = []
  let analysis = ''
  const status: 'ok' | 'issue' = 'issue'

  const nyceOnHand = nyceArticle?.onHandQty || 0
  const nyceInOrder = nyceArticle?.inOrderQty || 0
  const nycePhysical = nyceArticle?.physicalQty || 0
  const nyceStoppedQty = nyceArticle?.stoppedQty || 0
  const nyceAvailable = nyceOnHand - nyceInOrder

  details.push('Google Feed: NOT SELLABLE (Full Check mode)')

  // Apply the 4-scenario matrix
  if (commerceToolsStock > 0 && fluentStock > 0 && nyceOnHand > 0) {
    analysis = 'TROLIGTVIS EN SPÄRR (Probably a block)'
    details.push('All systems have stock but Google Feed shows not sellable')
    details.push('This indicates a business logic block/restriction (affärslogik spärr)')
    details.push('Action: Check business rules and restrictions in Google Feed logic')
  }
  else if (commerceToolsStock === 0 && fluentStock > 0 && nyceOnHand > 0) {
    analysis = 'TROLIGTVIS SYNKPROBLEM (Probably sync problem)'
    details.push(`CommerceTools shows 0 but Fluent has ${fluentStock} and NYCE has ${nyceOnHand}`)
    details.push('CommerceTools should mirror Fluent with some delay')
    details.push('Action: Check CommerceTools sync process with Fluent')
  }
  else if (commerceToolsStock === 0 && fluentStock === 0 && nyceOnHand > 0) {
    analysis = 'LAGERSYNKPROBLEM ELLER UTSÅLT (Inventory sync problem or sold out)'
    details.push(`NYCE has ${nyceOnHand} units but Fluent shows 0`)
    details.push('Either stock sync issue from NYCE to Fluent or items not digitally sellable')
    details.push('Action: Check if stock is available for digital sales in NYCE')
  }
  else if (commerceToolsStock === 0 && fluentStock === 0 && nyceOnHand === 0) {
    analysis = 'EJ INLEVERAT? (Not delivered?)'
    details.push('No stock in any system')
    details.push('Product may not have been delivered to warehouse yet')
    details.push('Action: Check delivery status and inbound shipments')
  }
  else {
    analysis = 'INVESTIGATE - Stock pattern not matching standard scenarios'
    details.push(`CT: ${commerceToolsStock}, Fluent: ${fluentStock}, NYCE: ${nyceOnHand}`)
  }

  if (nyceArticle) {
    addNyceInsights(details, nycePhysical, nyceOnHand, nyceInOrder, nyceStoppedQty, nyceAvailable, fluentStock)
  }

  return {
    psid,
    productName,
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
          sendEvent('progress', { message: 'Fetching Google Feed...', current: 0, total: psids.length })

          // Fetch Google Feed
          const googleFeedResponse = await fetch(process.env.NEXT_PUBLIC_GOOGLE_FEED_URL!)
          const googleProducts: GoogleFeedProduct[] = await googleFeedResponse.json()
          const googleMap = new Map(googleProducts.map(p => [p.id, p]))

          sendEvent('progress', { message: `Google Feed loaded: ${googleProducts.length} products`, current: 0, total: psids.length })

          // Get Fluent token
          sendEvent('progress', { message: 'Getting Fluent authentication...', current: 0, total: psids.length })
          const fluentToken = await getFluentToken()

          // Process NYCE CSV data
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

          sendEvent('progress', { message: `NYCE data loaded: ${nyceDataMap.size} items`, current: 0, total: psids.length })

          // Process each PSID
          let processedCount = 0
          for (let i = 0; i < psids.length; i++) {
            const psid = psids[i]
            const googleProduct = googleMap.get(psid)
            const googleSellable = googleProduct?.availability === 'in_stock'

            // Skip sellable items
            if (googleSellable) {
              sendEvent('progress', {
                message: `${psid} is sellable - skipping (${i + 1}/${psids.length})`,
                current: i + 1,
                total: psids.length
              })
              continue
            }

            processedCount++
            sendEvent('progress', {
              message: `Checking ${psid} - NOT sellable (${i + 1}/${psids.length})...`,
              current: i + 1,
              total: psids.length
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
              const autocompleteResponse = await fetch(autocompleteUrl)
              const autocompleteData: AutocompleteResponse = await autocompleteResponse.json()

              const matchedProduct = autocompleteData.products.find(p => p.variant && p.variant.sku === psid)
              const productName = matchedProduct?.productName || 'Unknown Product'
              const commerceToolsStock = matchedProduct?.variant?.inventoryQuantity || 0

              const nyceArticle = nyceDataMap.get(psid) || null

              // Analyze using Full Check logic (from stock-check/route.ts)
              const result = analyzeStockFull(psid, productName, commerceToolsStock, fluentStock, nyceArticle)
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

          sendEvent('progress', { message: `Full Check complete: processed ${processedCount} not-sellable items`, current: psids.length, total: psids.length })
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
              const commerceToolsStock = matchedProduct?.variant?.inventoryQuantity || 0
              const fluentStock = fluentMap.get(psid) || 0

              const result = analyzeStockSpot(psid, productName, commerceToolsStock, fluentStock)
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
        sendEvent('error', { message: `Fatal error: ${error}` })
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
