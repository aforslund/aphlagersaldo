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

// Helper to get Fluent inventory
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

// Analysis logic based on stock levels
function analyzeStock(
  psid: string,
  productName: string,
  googleSellable: boolean | null,
  commerceToolsStock: number,
  fluentStock: number,
  nyceArticle: any,
  skipGoogleFeed: boolean = false,
  skipNyce: boolean = false
): ProductStockResult {
  const details: string[] = []
  let analysis = ''
  let status: 'ok' | 'issue' = 'ok'

  // Extract NYCE data
  const nyceOnHand = nyceArticle?.onHandQty || 0
  const nyceInOrder = nyceArticle?.inOrderQty || 0
  const nycePhysical = nyceArticle?.physicalQty || 0
  const nyceStoppedQty = nyceArticle?.stoppedQty || 0
  const nyceAvailable = nyceOnHand - nyceInOrder

  // Special mode: Google Feed skipped (items known to be unavailable)
  if (skipGoogleFeed) {
    status = 'issue'
    details.push('Google Feed check skipped - item known to be unavailable on website')

    // Simplified spärr detection
    if (commerceToolsStock > 0 && fluentStock > 0) {
      analysis = 'TROLIGTVIS EN SPÄRR (Probably a block)'
      details.push('Both CommerceTools and Fluent have stock but item not available on website')
      details.push('This strongly indicates a business logic block (affärslogik spärr)')
      details.push('Action: Check business rules and restrictions')
    } else if (commerceToolsStock === 0 && fluentStock > 0) {
      analysis = 'TROLIGTVIS SYNKPROBLEM (Probably sync problem)'
      details.push(`CommerceTools shows 0 but Fluent has ${fluentStock}`)
      details.push('Action: Check CommerceTools sync process with Fluent')
    } else if (commerceToolsStock === 0 && fluentStock === 0 && nyceOnHand > 0) {
      analysis = 'LAGERSYNKPROBLEM ELLER UTSÅLT (Inventory sync problem or sold out)'
      details.push(`NYCE has ${nyceOnHand} units but Fluent shows 0`)
      details.push('Action: Check if stock is available for digital sales in NYCE')
    } else if (commerceToolsStock === 0 && fluentStock === 0 && (skipNyce || nyceOnHand === 0)) {
      analysis = 'EJ INLEVERAT? (Not delivered?)'
      details.push('No stock in any system')
      details.push('Action: Check delivery status')
    } else {
      analysis = 'INVESTIGATE - Review stock levels'
      details.push(`CT: ${commerceToolsStock}, Fluent: ${fluentStock}${!skipNyce ? `, NYCE: ${nyceOnHand}` : ''}`)
    }

    // Add NYCE insights if available
    if (!skipNyce && nyceArticle) {
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

  // Normal mode: Check Google Feed status
  // If Google is sellable and all systems have stock, it's OK
  if (googleSellable && commerceToolsStock > 0 && fluentStock > 0) {
    // Only check NYCE if not skipped
    if (!skipNyce && nyceOnHand === 0) {
      status = 'issue'
      analysis = 'WARNING - Google sellable but NYCE has no stock'
      details.push('Potential sync issue - check NYCE inventory')
    } else {
      return {
        psid,
        productName,
        googleSellable,
        commerceToolsStock,
        fluentStock,
        nyceStock: nyceArticle,
        status: 'ok',
        analysis: 'All systems in sync with stock available',
        details: [],
      }
    }
  }

  // If Google is not sellable, we need to investigate
  status = 'issue'

  // Check each system
  if (!googleSellable) {
    details.push('Google Feed: NOT SELLABLE')

    // Apply the logic from the screenshot matrix
    // Scenario 1: Troligtvis en spärr (Probably a block)
    // Google: Not Sellable, CT: >0, Fluent: >0, NYCE: >0
    if (commerceToolsStock > 0 && fluentStock > 0 && nyceOnHand > 0) {
      analysis = 'TROLIGTVIS EN SPÄRR (Probably a block)'
      details.push('All systems have stock but Google Feed shows not sellable')
      details.push('This indicates a business logic block/restriction (affärslogik spärr)')
      details.push('Action: Check business rules and restrictions in Google Feed logic')
    }
    // Scenario 2: Troligtvis synkproblem (Probably sync problem)
    // Google: Not Sellable, CT: 0, Fluent: >0, NYCE: >0
    else if (commerceToolsStock === 0 && fluentStock > 0 && nyceOnHand > 0) {
      analysis = 'TROLIGTVIS SYNKPROBLEM (Probably sync problem)'
      details.push(`CommerceTools shows 0 but Fluent has ${fluentStock} and NYCE has ${nyceOnHand}`)
      details.push('CommerceTools should mirror Fluent with some delay')
      details.push('Action: Check CommerceTools sync process with Fluent')
    }
    // Scenario 3: Lagersynkproblem eller utsålt (Inventory sync problem or sold out)
    // Google: Not Sellable, CT: 0, Fluent: 0, NYCE: >0
    else if (commerceToolsStock === 0 && fluentStock === 0 && nyceOnHand > 0) {
      analysis = 'LAGERSYNKPROBLEM ELLER UTSÅLT (Inventory sync problem or sold out)'
      details.push(`NYCE has ${nyceOnHand} units but Fluent shows 0`)
      details.push('Either stock sync issue from NYCE to Fluent or items not digitally sellable')
      details.push('Action: Check if stock is available for digital sales in NYCE')
    }
    // Scenario 4: Ej inleverat? (Not delivered?)
    // Google: Not Sellable, CT: 0, Fluent: 0, NYCE: 0
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
    if (!skipNyce && nyceArticle) {
      addNyceInsights(details, nycePhysical, nyceOnHand, nyceInOrder, nyceStoppedQty, nyceAvailable, fluentStock)
    }
  } else {
    // Google is sellable but we're here, so something is off
    if (commerceToolsStock === 0 || fluentStock === 0 || nyceOnHand === 0) {
      analysis = 'WARNING - Google shows sellable but missing stock in one or more systems'
      status = 'issue'

      if (commerceToolsStock === 0) details.push('CommerceTools: OUT OF STOCK')
      if (fluentStock === 0) details.push('Fluent: OUT OF STOCK')
      if (nyceOnHand === 0) details.push('NYCE: OUT OF STOCK')
    }
  }

  return {
    psid,
    productName,
    googleSellable,
    commerceToolsStock,
    fluentStock,
    nyceStock: nyceArticle,
    status,
    analysis,
    details,
  }
}

export async function POST(request: NextRequest) {
  try {
    const { psids, skipGoogleFeed, skipNyce, nyceCsvData }: StockCheckRequest = await request.json()

    if (!psids || psids.length === 0) {
      return NextResponse.json(
        { error: 'No PSIDs provided' },
        { status: 400 }
      )
    }

    const results: ProductStockResult[] = []
    const errors: string[] = []

    // Fetch Google Feed (unless skipped)
    let googleMap = new Map<string, GoogleFeedProduct>()
    if (!skipGoogleFeed) {
      try {
        const googleFeedResponse = await fetch(process.env.NEXT_PUBLIC_GOOGLE_FEED_URL!)
        const googleProducts: GoogleFeedProduct[] = await googleFeedResponse.json()
        googleMap = new Map(googleProducts.map(p => [p.id, p]))
      } catch (error) {
        errors.push('Failed to fetch Google Feed')
      }
    }

    // Get Fluent inventory
    let fluentMap: Map<string, number>
    try {
      const fluentToken = await getFluentToken()
      fluentMap = await getFluentInventory(fluentToken, process.env.FLUENT_LOCATION_REF!)
    } catch (error) {
      errors.push('Failed to fetch Fluent inventory')
      fluentMap = new Map()
    }

    // Get NYCE stock (from API or CSV, unless skipped)
    let nyceDataMap = new Map<string, any>()
    if (!skipNyce) {
      if (nyceCsvData) {
        // Use CSV data
        Object.keys(nyceCsvData).forEach(sku => {
          nyceDataMap.set(sku, {
            articleId: sku,
            onHandQty: nyceCsvData[sku].balance,
            inOrderQty: nyceCsvData[sku].inOrder,
            physicalQty: nyceCsvData[sku].balance, // Assume physical = balance from CSV
            stoppedQty: 0,
            allocatedQty: 0,
          })
        })
      } else {
        // Try to fetch from API
        try {
          const nyceToken = await getNyceToken()
          const nyceData = await getNyceStock(nyceToken, psids)
          nyceData.articles.forEach(article => {
            nyceDataMap.set(article.articleId, article)
          })
        } catch (error) {
          errors.push('Failed to fetch NYCE stock - please upload NYCE CSV or check "Skip NYCE"')
        }
      }
    }

    // Process each PSID
    for (const psid of psids) {
      try {
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100))

        // Get autocomplete data (CommerceTools stock)
        const autocompleteUrl = `${process.env.NEXT_PUBLIC_AUTOCOMPLETE_URL}?language=sv-SE&q=${psid}`
        const autocompleteResponse = await fetch(autocompleteUrl)
        const autocompleteData: AutocompleteResponse = await autocompleteResponse.json()

        const matchedProduct = autocompleteData.products.find(
          p => p.variant && p.variant.sku === psid
        )

        const productName = matchedProduct?.productName || 'Unknown Product'
        const commerceToolsStock = matchedProduct?.variant?.inventoryQuantity || 0
        const fluentStock = fluentMap.get(psid) || 0
        const googleProduct = googleMap.get(psid)
        const googleSellable = skipGoogleFeed ? null : (googleProduct?.availability === 'in_stock')
        const nyceArticle = nyceDataMap.get(psid) || null

        const result = analyzeStock(
          psid,
          productName,
          googleSellable,
          commerceToolsStock,
          fluentStock,
          nyceArticle,
          skipGoogleFeed,
          skipNyce
        )

        results.push(result)
      } catch (error) {
        errors.push(`Failed to process PSID ${psid}: ${error}`)
      }
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
