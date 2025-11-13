import { NextRequest, NextResponse } from 'next/server'
import type {
  StockCheckRequest,
  StockCheckResponse,
  GoogleFeedProduct,
  AutocompleteResponse,
  NyceResponse,
  ProductStockResult,
  FluentInventoryNode,
} from '@/types'

// Helper to get Fluent token
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

// Helper to get Fluent inventory (all items - for Full Check)
async function getFluentInventory(token: string, locationRef: string): Promise<Map<string, number>> {
  const query = `
    query inventoryPositions($locationRefs:[String], $cursor: String) {
      inventoryPositions(first: 5000, locationRef: $locationRefs, after: $cursor) {
        edges {
          node {
            locationRef
            productRef
            onHand
          }
          cursor
        }
        pageInfo {
          hasNextPage
        }
      }
    }`

  const inventoryMap = new Map<string, number>()
  let cursor: string | null = null
  let hasNextPage = true

  while (hasNextPage) {
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
          cursor,
        },
      }),
    })

    if (!response.ok) {
      throw new Error('Failed to fetch Fluent inventory')
    }

    const data = await response.json()
    const edges = data.data.inventoryPositions.edges

    edges.forEach((edge: { node: FluentInventoryNode; cursor: string }) => {
      inventoryMap.set(edge.node.productRef, edge.node.onHand)
      cursor = edge.cursor
    })

    hasNextPage = data.data.inventoryPositions.pageInfo.hasNextPage
  }

  return inventoryMap
}

// Helper to get Fluent inventory for specific PSIDs (queries each individually)
async function getFluentInventoryForProducts(token: string, locationRef: string, psids: string[]): Promise<Map<string, number>> {
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
  console.log(`Fetching Fluent inventory for ${psids.length} PSIDs individually...`)

  for (let i = 0; i < psids.length; i++) {
    const psid = psids[i]

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
        continue
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
        console.log(`Fluent: ${psid} = ${onHand}`)
      }

      // Add delay to avoid DDOS-like behavior (250ms between requests)
      if (i < psids.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    } catch (error) {
      console.error(`Error fetching Fluent inventory for ${psid}:`, error)
    }
  }

  console.log(`Fluent check complete: found ${inventoryMap.size}/${psids.length} items`)
  return inventoryMap
}

// Helper to get NYCE token
async function getNyceToken(): Promise<string> {
  const response = await fetch(`${process.env.NYCE_BASE_URL}/api/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userName: process.env.NYCE_USERNAME,
      password: process.env.NYCE_PASSWORD,
      client: process.env.NYCE_CLIENT,
      warehouse: process.env.NYCE_WAREHOUSE,
    }),
  })

  if (!response.ok) {
    throw new Error('Failed to authenticate with NYCE')
  }

  const data = await response.json()
  return data.token
}

// Helper to get NYCE stock
async function getNyceStock(token: string, skus: string[]): Promise<NyceResponse> {
  const response = await fetch(`${process.env.NYCE_BASE_URL}/api/custom/itembalance`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ skus }),
  })

  if (!response.ok) {
    throw new Error('Failed to fetch NYCE stock')
  }

  return await response.json()
}

// Helper to add NYCE-specific insights
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

  // Compare NYCE available with Fluent
  const difference = Math.abs(nyceAvailable - fluentStock)
  if (difference > 5) {
    details.push(`SYNC VARIANCE: NYCE available (${nyceAvailable}) vs Fluent (${fluentStock}) - difference of ${difference} units`)
    details.push('Note: Fluent is typically ahead as it releases to NYCE only when ready for picking')
  }
}

// FULL CHECK: Analysis for items NOT sellable in Google Feed
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

  // Extract NYCE data
  const nyceOnHand = nyceArticle?.onHandQty || 0
  const nyceInOrder = nyceArticle?.inOrderQty || 0
  const nycePhysical = nyceArticle?.physicalQty || 0
  const nyceStoppedQty = nyceArticle?.stoppedQty || 0
  const nyceAvailable = nyceOnHand - nyceInOrder

  details.push('Google Feed: NOT SELLABLE (Full Check mode)')

  // Apply the logic from the screenshot matrix
  // Scenario 1: Troligtvis en spärr (Probably a block)
  if (commerceToolsStock > 0 && fluentStock > 0 && nyceOnHand > 0) {
    analysis = 'TROLIGTVIS EN SPÄRR (Probably a block)'
    details.push('All systems have stock but Google Feed shows not sellable')
    details.push('This indicates a business logic block/restriction (affärslogik spärr)')
    details.push('Action: Check business rules and restrictions in Google Feed logic')
  }
  // Scenario 2: Troligtvis synkproblem (Probably sync problem)
  else if (commerceToolsStock === 0 && fluentStock > 0 && nyceOnHand > 0) {
    analysis = 'TROLIGTVIS SYNKPROBLEM (Probably sync problem)'
    details.push(`CommerceTools shows 0 but Fluent has ${fluentStock} and NYCE has ${nyceOnHand}`)
    details.push('CommerceTools should mirror Fluent with some delay')
    details.push('Action: Check CommerceTools sync process with Fluent')
  }
  // Scenario 3: Lagersynkproblem eller utsålt (Inventory sync problem or sold out)
  else if (commerceToolsStock === 0 && fluentStock === 0 && nyceOnHand > 0) {
    analysis = 'LAGERSYNKPROBLEM ELLER UTSÅLT (Inventory sync problem or sold out)'
    details.push(`NYCE has ${nyceOnHand} units but Fluent shows 0`)
    details.push('Either stock sync issue from NYCE to Fluent or items not digitally sellable')
    details.push('Action: Check if stock is available for digital sales in NYCE')
  }
  // Scenario 4: Ej inleverat? (Not delivered?)
  else if (commerceToolsStock === 0 && fluentStock === 0 && nyceOnHand === 0) {
    analysis = 'EJ INLEVERAT? (Not delivered?)'
    details.push('No stock in any system')
    details.push('Product may not have been delivered to warehouse yet')
    details.push('Action: Check delivery status and inbound shipments')
  }
  // Edge cases not covered in the matrix
  else {
    analysis = 'INVESTIGATE - Stock pattern not matching standard scenarios'
    details.push(`CT: ${commerceToolsStock}, Fluent: ${fluentStock}, NYCE: ${nyceOnHand}`)
  }

  // NYCE-specific insights
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

// SPOT-CHECK: Quick analysis of just CommerceTools and Fluent
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

  // Analyze sync between CT and Fluent
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
    // Both are 0
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
  try {
    const { psids, checkMode, nyceCsvData }: StockCheckRequest = await request.json()

    // Validate Full Check mode requirements
    if (checkMode === 'full' && !nyceCsvData) {
      return NextResponse.json(
        { error: 'Full Check mode requires NYCE CSV data' },
        { status: 400 }
      )
    }

    // Validate Spot-check mode requirements
    if (checkMode === 'spot' && (!psids || psids.length === 0)) {
      return NextResponse.json(
        { error: 'Spot-check mode requires PSIDs' },
        { status: 400 }
      )
    }

    const results: ProductStockResult[] = []
    const errors: string[] = []

    // FULL CHECK MODE: Google Feed → filter not sellable → check NYCE, Fluent, Autocomplete
    if (checkMode === 'full') {
      // 1. Fetch Google Feed
      let googleMap = new Map<string, GoogleFeedProduct>()
      try {
        const googleFeedResponse = await fetch(process.env.NEXT_PUBLIC_GOOGLE_FEED_URL!)
        const googleProducts: GoogleFeedProduct[] = await googleFeedResponse.json()
        googleMap = new Map(googleProducts.map(p => [p.id, p]))
      } catch (error) {
        errors.push('Failed to fetch Google Feed')
        return NextResponse.json({ results: [], errors }, { status: 500 })
      }

      // 2. Get Fluent inventory
      let fluentMap: Map<string, number>
      try {
        const fluentToken = await getFluentToken()
        fluentMap = await getFluentInventory(fluentToken, process.env.FLUENT_LOCATION_REF!)
      } catch (error) {
        errors.push('Failed to fetch Fluent inventory')
        fluentMap = new Map()
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

      // 4. Process each PSID - only check items that are NOT sellable in Google Feed
      for (const psid of psids) {
        try {
          await new Promise(resolve => setTimeout(resolve, 100))

          const googleProduct = googleMap.get(psid)
          const googleSellable = googleProduct?.availability === 'in_stock'

          // Skip items that ARE sellable (only process not sellable items)
          if (googleSellable) {
            results.push({
              psid,
              productName: 'N/A',
              googleSellable: true,
              commerceToolsStock: 0,
              fluentStock: 0,
              nyceStock: null,
              status: 'ok',
              analysis: 'Sellable in Google Feed - skipped in Full Check mode',
              details: ['Full Check only analyzes items not sellable in Google Feed'],
            })
            continue
          }

          // Get autocomplete data
          const autocompleteUrl = `${process.env.NEXT_PUBLIC_AUTOCOMPLETE_URL}?language=sv-SE&q=${psid}`
          const autocompleteResponse = await fetch(autocompleteUrl)
          const autocompleteData: AutocompleteResponse = await autocompleteResponse.json()

          const matchedProduct = autocompleteData.products.find(
            p => p.variant && p.variant.sku === psid
          )

          const productName = matchedProduct?.productName || 'Unknown Product'
          const commerceToolsStock = matchedProduct?.variant?.inventoryQuantity || 0
          const fluentStock = fluentMap.get(psid) || 0
          const nyceArticle = nyceDataMap.get(psid) || null

          const result = analyzeStockFull(
            psid,
            productName,
            commerceToolsStock,
            fluentStock,
            nyceArticle
          )

          results.push(result)
        } catch (error) {
          errors.push(`Failed to process PSID ${psid}: ${error}`)
        }
      }
    }
    // SPOT-CHECK MODE: Only check Autocomplete and Fluent
    else {
      const spotCheckStart = Date.now()

      // Get Fluent inventory for ONLY the specific PSIDs (much faster!)
      let fluentMap: Map<string, number>
      try {
        const fluentStart = Date.now()
        const fluentToken = await getFluentToken()
        console.log(`Got Fluent token in ${Date.now() - fluentStart}ms`)

        fluentMap = await getFluentInventoryForProducts(fluentToken, process.env.FLUENT_LOCATION_REF!, psids)
        console.log(`Total Fluent inventory fetch: ${Date.now() - fluentStart}ms`)
      } catch (error) {
        console.error('Fluent inventory fetch error:', error)
        errors.push(`Failed to fetch Fluent inventory: ${error instanceof Error ? error.message : String(error)}`)
        fluentMap = new Map()
      }

      // Process PSIDs in parallel batches for speed
      const autocompleteStart = Date.now()
      const batchSize = 10 // Increased from 5 to 10 for more parallelism
      for (let i = 0; i < psids.length; i += batchSize) {
        const batch = psids.slice(i, i + batchSize)

        const batchPromises = batch.map(async (psid) => {
          try {
            // Get autocomplete data
            const autocompleteUrl = `${process.env.NEXT_PUBLIC_AUTOCOMPLETE_URL}?language=sv-SE&q=${psid}`
            const autocompleteResponse = await fetch(autocompleteUrl)
            const autocompleteData: AutocompleteResponse = await autocompleteResponse.json()

            const matchedProduct = autocompleteData.products.find(
              p => p.variant && p.variant.sku === psid
            )

            const productName = matchedProduct?.productName || 'Unknown Product'
            const commerceToolsStock = matchedProduct?.variant?.inventoryQuantity || 0
            const fluentStock = fluentMap.get(psid) || 0

            return analyzeStockSpot(
              psid,
              productName,
              commerceToolsStock,
              fluentStock
            )
          } catch (error) {
            errors.push(`Failed to process PSID ${psid}: ${error}`)
            return null
          }
        })

        const batchResults = await Promise.all(batchPromises)
        results.push(...batchResults.filter(r => r !== null) as ProductStockResult[])
      }

      console.log(`Autocomplete processing: ${Date.now() - autocompleteStart}ms`)
      console.log(`Total spot-check time: ${Date.now() - spotCheckStart}ms`)
    }

    const response: StockCheckResponse = {
      results,
      errors,
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('Stock check error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
